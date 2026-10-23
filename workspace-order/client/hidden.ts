import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { hiddenWorkspacesSettings } from "../shared/hidden";

declare const console: { warn(...args: unknown[]): void };

interface Host {
  client: PluginClientContext;
  names: readonly string[];
}
interface Shared {
  hosts: Set<Host>;
  hidden: ReadonlySet<string>;
  listeners: Set<() => void>;
}

const settings = settingsRpc(hiddenWorkspacesSettings.id);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The app loads a copy of this plugin for every host that has it, all in one JavaScript realm. Each
// copy keeps its own host's list here and the sidebar hides all of them. Bump the version when this
// shape changes, so copies of different versions do not share it.
const SHARED = Symbol.for("ragokan/paseo-plugins/workspace-order/hidden@1");
function shared(): Shared {
  const realm = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (realm[SHARED] ??= { hosts: new Set(), hidden: new Set(), listeners: new Set() });
}

function publish(state: Shared) {
  state.hidden = new Set([...state.hosts].flatMap((host) => host.names));
  for (const listener of state.listeners) listener();
}

async function read(host: Host) {
  const result = await host.client.rpc(settings.read, {});
  if (result.status !== "ready") throw new Error(result.error);
  return { names: hiddenWorkspacesSettings.schema.parse(result.values).names, revision: result.revision };
}

async function refresh(state: Shared, host: Host) {
  try {
    host.names = (await read(host)).names;
  } catch (error) {
    console.warn("[workspace-order] could not read this host's hidden workspaces", error);
    return;
  }
  if (state.hosts.has(host)) publish(state);
}

/** Adds this copy's host to the hidden workspaces; the returned function takes it out again. */
export function joinHiddenWorkspaces(client: PluginClientContext): () => void {
  const state = shared();
  const host: Host = { client, names: [] };
  state.hosts.add(host);
  // Reads the list when the subscription starts and again after a reconnect, or when an app saves it.
  let observation: ReturnType<PluginClientContext["paseo"]["observeEvents"]> | undefined;
  try {
    observation = client.paseo.observeEvents(["status.plugin_settings_changed"]);
    observation.subscribe({
      snapshot: () => void refresh(state, host),
      update: (event) => {
        if (event.type !== "status" || event.payload.status !== "plugin_settings_changed") return;
        if (event.payload.settingsId === hiddenWorkspacesSettings.id) void refresh(state, host);
      },
    });
  } catch (error) {
    console.warn("[workspace-order] cannot follow this host's hidden workspaces; reading them once", error);
    void refresh(state, host);
  }
  return () => {
    observation?.release().catch(() => {});
    state.hosts.delete(host);
    publish(state);
  };
}

/** A name starting with 0 never shows in the sidebar, whatever the hosts list: a way to name a workspace out of it. */
export const alwaysHidden = (name: string) => name.startsWith("0");

export function readHidden(): ReadonlySet<string> {
  return shared().hidden;
}

export function subscribeHidden(listener: () => void) {
  const { listeners } = shared();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hides or shows a workspace on every host the app reaches. Throws after trying them all. */
export async function setHidden(name: string, hide: boolean) {
  const state = shared();
  const hosts = [...state.hosts];
  const failures: string[] = [];
  await Promise.all(
    hosts.map(async (host) => {
      try {
        // Saves against the revision just read; another app saving in between costs one more read.
        for (let attempt = 1; ; attempt += 1) {
          const { names, revision } = await read(host);
          host.names = names;
          if (names.includes(name) === hide) return;
          const next = hide ? [...names, name] : names.filter((other) => other !== name);
          const result = await host.client.rpc(settings.write, { revision, values: { names: next } });
          if (result.status === "saved") {
            host.names = next;
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
