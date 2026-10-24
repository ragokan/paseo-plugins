import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { workspaceSettings, type WorkspaceValues } from "../shared/workspaces";
import { doneMark, IDLE_FOR } from "./idle";

declare const console: { warn(...args: unknown[]): void };

interface Host {
  client: PluginClientContext;
  values: WorkspaceValues;
}
interface Shared {
  hosts: Set<Host>;
  hidden: ReadonlySet<string>;
  done: ReadonlySet<string>;
  listeners: Set<() => void>;
}

const EMPTY: WorkspaceValues = { hidden: [], done: {} };
const settings = settingsRpc(workspaceSettings.id);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The app loads a copy of this plugin for every host that has it, all in one JavaScript realm. Each
// copy keeps its own host's settings here, and the sidebar follows all of them. Bump the version
// when this shape changes in a way older copies cannot share; they leave out fields added since.
const SHARED = Symbol.for("ragokan/paseo-plugins/tweaks/hosts@1");
function shared(): Shared {
  const realm = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (realm[SHARED] ??= { hosts: new Set(), hidden: new Set(), done: new Set(), listeners: new Set() });
}

// A name any host hides is hidden.
function publish(state: Shared) {
  const hosts = [...state.hosts];
  state.hidden = new Set(hosts.flatMap((host) => host.values.hidden));
  state.done = new Set(hosts.flatMap((host) => Object.entries(host.values.done).map(([id, at]) => doneMark(id, at))));
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
    console.warn("[tweaks] could not read this host's workspace settings", error);
    return;
  }
  if (state.hosts.has(host)) publish(state);
}

/** Adds this copy's host to the hidden workspaces and those marked as done; the returned function takes it out again. */
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
    console.warn("[tweaks] cannot follow this host's workspace settings; reading them once", error);
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

/** The workspaces marked as done in Idle by hand, as doneMark keys. */
export function readDone(): ReadonlySet<string> {
  return shared().done;
}

export function subscribe(listener: () => void) {
  const { listeners } = shared();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Saves a change on every host the app reaches, or on the given ones; change returns null when a
// host needs none. Throws after trying them all.
async function update(change: (values: WorkspaceValues) => WorkspaceValues | null, hosts = [...shared().hosts]) {
  const state = shared();
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

/**
 * Marks a workspace in Idle as done, so it moves to Done until its status changes, on the host the
 * given copy came from: the host the workspace is on, since Paseo offers a copy's commands only on
 * its own host's workspaces. Marks of workspaces that have been in Done a day go, since those are in
 * Done anyway.
 */
export function markDone(client: PluginClientContext, workspaceId: string, enteredAt: number) {
  const host = [...shared().hosts].find((other) => other.client === client);
  if (!host) return Promise.reject(new Error("This host's workspace settings are not loaded"));
  return update((values) => {
    const now = Date.now();
    const kept = Object.entries(values.done).filter(([id, at]) => id !== workspaceId && now - at < IDLE_FOR);
    return { ...values, done: Object.fromEntries([...kept, [workspaceId, enteredAt]]) };
  }, [host]);
}
