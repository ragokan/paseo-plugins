import type { PluginClientContext } from "@getpaseo/plugin/client";

declare const console: { warn(...args: unknown[]): void };

// The fields of Paseo's agent snapshot this plugin reads.
interface AgentSnapshot {
  id: string;
  workspaceId?: string;
  status: string;
  labels: Record<string, string>;
  archivedAt?: string | null;
}
interface Agent {
  workspaceId?: string;
  parentId: string | null;
  working: boolean;
}
interface Host {
  agents: Map<string, Agent>;
}
interface Shared {
  hosts: Set<Host>;
  waiting: ReadonlySet<string>;
  listeners: Set<() => void>;
}

// Paseo labels an agent another agent started with the starter's id, on whichever host it runs.
const PARENT_LABEL = "paseo.parent-agent-id";

// The app loads a copy of this plugin for every host that has it, all in one JavaScript realm. Each
// copy keeps its own host's agents here, so a subagent on another host counts too. Bump the version
// when this shape changes.
const SHARED = Symbol.for("ragokan/paseo-plugins/tweaks/agents@1");
function shared(): Shared {
  const realm = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (realm[SHARED] ??= { hosts: new Set(), waiting: new Set(), listeners: new Set() });
}

function toAgent(agent: AgentSnapshot): Agent | null {
  if (agent.archivedAt) return null;
  return {
    workspaceId: agent.workspaceId,
    parentId: agent.labels[PARENT_LABEL] ?? null,
    working: agent.status === "running" || agent.status === "initializing",
  };
}

/** The workspaces with an agent that is not working while an agent it started, or one those started, is. */
export function waitingWorkspaces(agents: ReadonlyMap<string, Agent>): Set<string> {
  const children = new Map<string, string[]>();
  for (const [id, agent] of agents) {
    if (agent.parentId) children.set(agent.parentId, [...(children.get(agent.parentId) ?? []), id]);
  }
  const busy = (id: string, seen: Set<string>): boolean =>
    (children.get(id) ?? []).some((child) => {
      if (seen.has(child)) return false;
      seen.add(child);
      return agents.get(child)!.working || busy(child, seen);
    });
  const waiting = new Set<string>();
  for (const [id, agent] of agents) {
    if (agent.workspaceId && !agent.working && busy(id, new Set([id]))) waiting.add(agent.workspaceId);
  }
  return waiting;
}

// Tells the sidebar only when the waiting workspaces change, not on every agent update.
function publish(state: Shared) {
  const agents = new Map([...state.hosts].flatMap((host) => [...host.agents]));
  const waiting = waitingWorkspaces(agents);
  if (waiting.size === state.waiting.size && [...waiting].every((id) => state.waiting.has(id))) return;
  state.waiting = waiting;
  for (const listener of state.listeners) listener();
}

/** Follows this copy's host's agents, background ones included; the returned function stops. */
export function joinAgents(client: PluginClientContext): () => void {
  const state = shared();
  const host: Host = { agents: new Map() };
  state.hosts.add(host);
  let stopped = false;
  let release: (() => Promise<void>) | undefined;
  const accept = (entries: ReadonlyArray<{ agent: AgentSnapshot }>) => {
    host.agents = new Map();
    for (const { agent } of entries) {
      const tracked = toAgent(agent);
      if (tracked) host.agents.set(agent.id, tracked);
    }
    publish(state);
  };
  // shortcut: reads the first 200 active agents, which the subscription's snapshots also cover;
  // a host with more misses the rest until they change.
  // Started in a promise so an app without the agent list warns instead of throwing.
  Promise.resolve()
    .then(() => client.paseo.agents.list({ scope: "active", includeBackground: true, page: { limit: 200 }, subscribe: {} }))
    .then((result) => {
      if (stopped) return void result.subscription.release().catch(() => {});
      release = () => result.subscription.release();
      accept(result.entries);
      result.subscription.subscribe({
        snapshot: (snapshot) => accept(snapshot.entries),
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          const tracked = update.kind === "upsert" ? toAgent(update.agent) : null;
          const id = update.kind === "upsert" ? update.agent.id : update.agentId;
          if (tracked) host.agents.set(id, tracked);
          else host.agents.delete(id);
          publish(state);
        },
      });
    })
    .catch((error: unknown) => console.warn("[tweaks] cannot follow this host's agents; Waiting leaves them out", error));
  return () => {
    stopped = true;
    release?.().catch(() => {});
    state.hosts.delete(host);
    publish(state);
  };
}

/** The workspaces waiting on a subagent, by id. */
export function readWaiting(): ReadonlySet<string> {
  return shared().waiting;
}

export function subscribeWaiting(listener: () => void) {
  const { listeners } = shared();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
