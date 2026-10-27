import type { HostRuntimeStore, UpdatePreview, UpdateResult } from "./app";

export interface PluginChange {
  id: string;
  from?: string;
  to?: string;
}
export interface HostUpdate {
  serverId: string;
  label: string;
  state: "checking" | "updating" | "done" | "failed";
  /** While updating, what is being applied; once done, what was. */
  updated: PluginChange[];
  failed: Array<{ id: string; error: string }>;
  /** Plugins installed from a local folder, which update by reload instead. */
  local: string[];
  warnings: string[];
  error?: string;
}
export interface UpdateRun {
  startedAt: number;
  finished: boolean;
  hosts: HostUpdate[];
}

// The app loads a copy of this plugin per host, and updating this plugin reloads it mid-run. Copies
// share the run through the realm, so a reloaded screen still shows it. Bump the version when the
// shape changes, so copies of different versions do not share it.
const SHARED = Symbol.for("ragokan/paseo-plugins/command-panel/updates@1");
interface Shared {
  run: UpdateRun | null;
  listeners: Set<() => void>;
}
function shared(): Shared {
  const realm = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (realm[SHARED] ??= { run: null, listeners: new Set() });
}

export function readRun(): UpdateRun | null {
  return shared().run;
}

export function subscribeRun(listener: () => void): () => void {
  const { listeners } = shared();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(run: UpdateRun) {
  const state = shared();
  state.run = run;
  for (const listener of [...state.listeners]) listener();
}

const shortRevision = (revision: string | undefined) => (revision && /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision);
const targetRevision = (preview: UpdatePreview) =>
  preview.target?.kind === "git" ? preview.target.commit : preview.target?.kind === "npm" ? preview.target.version : undefined;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What `paseo plugin update --all --yes` does, on one host. */
async function updateHost(store: HostRuntimeStore, host: HostUpdate, report: (host: HostUpdate) => void) {
  const snapshot = store.getSnapshot(host.serverId);
  if (snapshot?.connectionStatus !== "online" || !snapshot.client) throw new Error("Offline");
  const { client } = snapshot;
  const preview = await client.previewPluginUpdates({});
  const proposed = preview.filter((item) => item.proposal);
  const changes = new Map(
    proposed.map((item) => [item.id, { id: item.id, from: shortRevision(item.current?.currentRevision), to: shortRevision(targetRevision(item)) }]),
  );
  const failed = preview.filter((item) => item.outcome === "error").map((item) => ({ id: item.id, error: item.error ?? "Check failed" }));
  const local = preview.filter((item) => item.outcome === "local").map((item) => item.id);
  if (proposed.length === 0) return report({ ...host, state: "done", failed, local });
  report({ ...host, state: "updating", updated: [...changes.values()], failed, local });
  const results: UpdateResult[] = await client.applyPluginUpdates(proposed.map((item) => item.proposal));
  report({
    ...host,
    state: "done",
    updated: results.filter((item) => item.outcome === "updated").flatMap((item) => changes.get(item.id) ?? { id: item.id }),
    failed: [...failed, ...results.filter((item) => item.outcome === "error").map((item) => ({ id: item.id, error: item.error ?? "Update failed" }))],
    local,
    warnings: results.flatMap((item) => (item.warning ? [`${item.id}: ${item.warning}`] : [])),
  });
}

/**
 * Updates every plugin with a newer version on every host the app has, all hosts at once. A run
 * already going is returned instead of starting another.
 */
export function updateAllPlugins(store: HostRuntimeStore): Promise<void> {
  const current = readRun();
  if (current && !current.finished) return Promise.resolve();
  let run: UpdateRun = {
    startedAt: Date.now(),
    finished: false,
    hosts: store.getHosts().map(({ serverId, label }) => ({
      serverId,
      label: label.trim() || serverId,
      state: "checking",
      updated: [],
      failed: [],
      local: [],
      warnings: [],
    })),
  };
  publish(run);
  const report = (host: HostUpdate) => {
    run = { ...run, hosts: run.hosts.map((other) => (other.serverId === host.serverId ? host : other)) };
    publish(run);
  };
  return Promise.all(
    run.hosts.map((host) => updateHost(store, host, report).catch((error: unknown) => report({ ...host, state: "failed", error: message(error) }))),
  ).then(() => publish({ ...run, finished: true }));
}
