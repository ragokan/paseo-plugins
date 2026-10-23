import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { workspaceSettings, type WorkspaceValues } from "../shared/workspaces";

declare const console: { warn(...args: unknown[]): void };

interface Host {
  client: PluginClientContext;
  values: WorkspaceValues;
}
interface Shared {
  hosts: Set<Host>;
  hidden: ReadonlySet<string>;
  order: readonly string[] | null;
  listeners: Set<() => void>;
}

const EMPTY: WorkspaceValues = { hidden: [], order: [], orderSavedAt: 0 };
const settings = settingsRpc(workspaceSettings.id);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The app loads a copy of this plugin for every host that has it, all in one JavaScript realm. Each
// copy keeps its own host's settings here, and the sidebar follows all of them. Bump the version
// when this shape changes, so copies of different versions do not share it.
const SHARED = Symbol.for("ragokan/paseo-plugins/workspace-order/hosts@1");
function shared(): Shared {
  const realm = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (realm[SHARED] ??= { hosts: new Set(), hidden: new Set(), order: null, listeners: new Set() });
}

// A name any host hides is hidden; the order saved last wins, since a host that was offline keeps an older one.
function publish(state: Shared) {
  const hosts = [...state.hosts];
  state.hidden = new Set(hosts.flatMap((host) => host.values.hidden));
  const newest = hosts.reduce<Host | undefined>(
    (best, host) => (host.values.orderSavedAt > (best?.values.orderSavedAt ?? 0) ? host : best),
    undefined,
  );
  state.order = newest ? newest.values.order : null;
  for (const listener of state.listeners) listener();
}

async function read(host: Host) {
  const result = await host.client.rpc(settings.read, {});
  if (result.status !== "ready") throw new Error(result.error);
  return { values: workspaceSettings.schema.parse(result.values), revision: result.revision };
}

async function refresh(state: Shared, host: Host) {
  try {
    host.values = (await read(host)).values;
  } catch (error) {
    console.warn("[workspace-order] could not read this host's workspace settings", error);
    return;
  }
  if (state.hosts.has(host)) publish(state);
}

/** Adds this copy's host to the order and hidden workspaces; the returned function takes it out again. */
export function joinWorkspaceSettings(client: PluginClientContext): () => void {
  const state = shared();
  const host: Host = { client, values: EMPTY };
  state.hosts.add(host);
  // Reads the settings when the subscription starts and again after a reconnect, or when an app saves them.
  let observation: ReturnType<PluginClientContext["paseo"]["observeEvents"]> | undefined;
  try {
    observation = client.paseo.observeEvents(["status.plugin_settings_changed"]);
    observation.subscribe({
      snapshot: () => void refresh(state, host),
      update: (event) => {
        if (event.type !== "status" || event.payload.status !== "plugin_settings_changed") return;
        if (event.payload.settingsId === workspaceSettings.id) void refresh(state, host);
      },
    });
  } catch (error) {
    console.warn("[workspace-order] cannot follow this host's workspace settings; reading them once", error);
    void refresh(state, host);
  }
  return () => {
    observation?.release().catch(() => {});
    state.hosts.delete(host);
    publish(state);
  };
}

/** A name starting with a digit, like a pull request's 7555-markdown-table, never shows in the sidebar, whatever the hosts list. */
export const alwaysHidden = (name: string) => /^\d/.test(name);

export function readHidden(): ReadonlySet<string> {
  return shared().hidden;
}

/** The order saved last on any host the app reaches, or null while none has one. */
export function readSyncedOrder(): readonly string[] | null {
  return shared().order;
}

export function subscribe(listener: () => void) {
  const { listeners } = shared();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Saves a change on every host the app reaches; change returns null when a host needs none.
// Throws after trying them all.
async function update(change: (values: WorkspaceValues) => WorkspaceValues | null) {
  const state = shared();
  const hosts = [...state.hosts];
  const failures: string[] = [];
  await Promise.all(
    hosts.map(async (host) => {
      try {
        // Saves against the revision just read; another app saving in between costs one more read.
        for (let attempt = 1; ; attempt += 1) {
          const { values, revision } = await read(host);
          const next = change(values);
          if (!next) {
            host.values = values;
            return;
          }
          const result = await host.client.rpc(settings.write, { revision, values: next });
          if (result.status === "saved") {
            host.values = next;
            return;
          }
          if (result.status !== "conflict" || attempt === 2) throw new Error(result.error);
        }
      } catch (error) {
        failures.push(message(error));
      }
    }),
  );
  publish(state);
  if (failures.length > 0) {
    throw new Error(`Could not save on ${failures.length} of ${hosts.length} hosts: ${[...new Set(failures)].join("; ")}`);
  }
}

/** Hides or shows a workspace on every host the app reaches. */
export function setHidden(name: string, hide: boolean) {
  return update((values) =>
    values.hidden.includes(name) === hide
      ? null
      : { ...values, hidden: hide ? [...values.hidden, name] : values.hidden.filter((other) => other !== name) },
  );
}

/** Saves the order on every host the app reaches, and shows it at once. */
export function saveSyncedOrder(names: string[]) {
  const state = shared();
  const orderSavedAt = Date.now();
  for (const host of state.hosts) host.values = { ...host.values, order: names, orderSavedAt };
  publish(state);
  return update((values) => ({ ...values, order: names, orderSavedAt }));
}
