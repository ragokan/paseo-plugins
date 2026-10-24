import type { AgentSnapshot, Api, Daemon, Subscription, WorkspaceSnapshot } from "./daemon.ts";
import {
  type Agent,
  type DoneMarks,
  doneSince,
  LABELS,
  labelChanges,
  labelFor,
  managedLabel,
  nextIdleEnd,
  waitingWorkspaces,
  type Workspace,
} from "./labels.ts";
import { dataDirectory, loadDoneSince, saveDoneSince } from "./store.ts";

// Paseo labels an agent another agent started with the starter's id, on whichever host it runs.
const PARENT_LABEL = "paseo.parent-agent-id";
// shortcut: Paseo's largest page. A host with more active workspaces or agents has the rest left out
// until they change.
const PAGE = { limit: 200 };
// How often the hosts are looked for again, and the labels checked whatever happened.
const RECHECK_EVERY = 60_000;
// This host's agents, beside the other hosts' under their server ids.
const SELF = "";

export interface FollowOptions {
  daemon: Daemon;
  paseo: Api;
  /** False takes this plugin's labels off. */
  enabled: () => boolean;
  doneMarks: () => Promise<DoneMarks>;
}

interface Followed<Entry> {
  subscription?: Subscription<Entry>;
}
interface FollowedAgents extends Followed<{ agent: AgentSnapshot }> {
  agents: Map<string, Agent>;
}

function toAgent(agent: AgentSnapshot): Agent | null {
  if (agent.archivedAt) return null;
  return {
    workspaceId: agent.workspaceId,
    parentId: agent.labels?.[PARENT_LABEL] ?? null,
    working: agent.status === "running" || agent.status === "initializing",
  };
}

/**
 * Labels this host's workspaces by the sidebar group they are in, as their status, their agents and
 * the agents those started on every host this one reaches change. relabel checks them again now, for
 * a change it is not told of, like the switch.
 */
export function followLabels({ daemon, paseo, enabled, doneMarks }: FollowOptions): { relabel: () => void; stop: () => Promise<void> } {
  const workspaces = new Map<string, Workspace>();
  // Until the first list arrives, an empty map would forget every workspace's time in Done.
  let workspacesListed = false;
  let followedWorkspaces: Followed<WorkspaceSnapshot> | undefined;
  const directory = dataDirectory();
  let since = loadDoneSince(directory);
  const hosts = new Map<string, FollowedAgents>();
  let stopped = false;

  let running = false;
  let again = false;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let idleEnd: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    clearTimeout(soon);
    // Updates come in bursts; one pass a moment later covers them all.
    soon = setTimeout(() => void label(), 300);
  };

  async function label() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      if (!workspacesListed) return;
      const now = Date.now();
      const done = await doneMarks();
      const next = doneSince(since, workspaces.values(), done);
      if (JSON.stringify(next) !== JSON.stringify(since)) saveDoneSince(directory, next);
      since = next;
      const waiting = waitingWorkspaces(new Map([...hosts.values()].flatMap((host) => [...host.agents])));
      const on = enabled();
      for (const workspace of [...workspaces.values()]) {
        if (stopped) return;
        const { remove, add } = labelChanges(workspace.labels ?? [], on ? labelFor(workspace, now, waiting, since, done) : null);
        try {
          for (const name of remove) {
            const label = { name, color: LABELS[managedLabel(name)!] };
            ({ workspaceLabels: workspace.labels } = await daemon.setWorkspaceLabel({ workspaceId: workspace.id, label, assigned: false }));
          }
          if (add) {
            const label = { name: add, color: LABELS[add] };
            ({ workspaceLabels: workspace.labels } = await daemon.setWorkspaceLabel({ workspaceId: workspace.id, label, assigned: true }));
          }
        } catch (error) {
          // An archived workspace is gone by the next pass; anything else is tried again then.
          console.warn(`[status-labels] could not label ${workspace.id}:`, error);
        }
      }
      // A workspace leaves Idle when its day is up, with nothing else changing.
      clearTimeout(idleEnd);
      const end = on ? nextIdleEnd(workspaces.values(), now, waiting, since, done) : null;
      // A timer can fire a little early; the second's margin keeps it from finding the workspace still in Idle.
      if (end !== null && !stopped) idleEnd = setTimeout(schedule, Math.max(0, end - Date.now()) + 1000);
    } catch (error) {
      console.warn("[status-labels] could not label the workspaces:", error);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }

  function release(followed: Followed<unknown> | undefined) {
    void followed?.subscription?.release().catch(() => {});
  }

  async function followWorkspaces() {
    const followed: Followed<WorkspaceSnapshot> = {};
    followedWorkspaces = followed;
    // Gone when it is stopped, or when it failed and the next recheck follows again.
    const current = () => followedWorkspaces === followed && !stopped;
    const forget = () => {
      if (followedWorkspaces === followed) followedWorkspaces = undefined;
      release(followed);
    };
    try {
      const { entries, subscription } = await paseo.workspaces.list({ includeBackground: true, page: PAGE, subscribe: {} });
      followed.subscription = subscription;
      if (!current()) return release(followed);
      const accept = (entries: WorkspaceSnapshot[]) => {
        workspaces.clear();
        for (const workspace of entries) workspaces.set(workspace.id, workspace);
        workspacesListed = true;
        schedule();
      };
      accept(entries);
      subscription.subscribe({
        snapshot: (snapshot) => accept(snapshot.entries),
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload as { kind: string; workspace?: WorkspaceSnapshot; id?: string };
          if (update.kind === "upsert" && update.workspace) workspaces.set(update.workspace.id, update.workspace);
          else if (update.id) workspaces.delete(update.id);
          schedule();
        },
        error: forget,
      });
    } catch (error) {
      forget();
      throw error;
    }
  }

  function unfollowAgents(host: string, followed = hosts.get(host)) {
    if (!followed || hosts.get(host) !== followed) return;
    hosts.delete(host);
    release(followed);
    schedule();
  }

  async function followAgents(api: Api | Promise<Api>, host: string) {
    const followed: FollowedAgents = { agents: new Map() };
    hosts.set(host, followed);
    const current = () => hosts.get(host) === followed && !stopped;
    try {
      const { entries, subscription } = await (await api).agents.list({ scope: "active", includeBackground: true, page: PAGE, subscribe: {} });
      followed.subscription = subscription;
      if (!current()) return release(followed);
      const accept = (entries: Array<{ agent: AgentSnapshot }>) => {
        followed.agents.clear();
        for (const { agent } of entries) {
          const tracked = toAgent(agent);
          if (tracked) followed.agents.set(agent.id, tracked);
        }
        schedule();
      };
      accept(entries);
      subscription.subscribe({
        snapshot: (snapshot) => accept(snapshot.entries),
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload as { kind: string; agent?: AgentSnapshot; agentId?: string };
          const id = update.agent?.id ?? update.agentId;
          if (!id) return;
          const tracked = update.kind === "upsert" && update.agent ? toAgent(update.agent) : null;
          if (tracked) followed.agents.set(id, tracked);
          else followed.agents.delete(id);
          schedule();
        },
        error: () => unfollowAgents(host, followed),
      });
    } catch (error) {
      unfollowAgents(host, followed);
      throw error;
    }
  }

  // Subagents on the other hosts this daemon reaches keep their starter's workspace in Waiting too.
  async function followHosts() {
    const { hosts: directory } = await paseo.hosts.list();
    const online = new Set(directory.filter((host) => host.enabled && host.status === "online").map((host) => host.serverId));
    for (const host of [...hosts.keys()]) {
      if (host !== SELF && !online.has(host)) unfollowAgents(host);
    }
    for (const host of online) {
      if (hosts.has(host) || stopped) continue;
      followAgents(paseo.hosts.client(host), host).catch((error: unknown) =>
        console.warn(`[status-labels] cannot follow the agents on ${host}; Waiting leaves them out:`, error),
      );
    }
  }

  // Follows again whatever failed, and checks the labels whatever happened.
  const recheck = () => {
    if (!followedWorkspaces) {
      followWorkspaces().catch((error: unknown) => console.error("[status-labels] cannot follow this host's workspaces:", error));
    }
    if (!hosts.has(SELF)) {
      followAgents(paseo, SELF).catch((error: unknown) => console.error("[status-labels] cannot follow this host's agents:", error));
    }
    followHosts().catch((error: unknown) => console.warn("[status-labels] cannot list the other hosts:", error));
    schedule();
  };
  recheck();
  const timer = setInterval(recheck, RECHECK_EVERY);

  return {
    relabel: schedule,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(soon);
      clearTimeout(idleEnd);
      const followed = [followedWorkspaces, ...hosts.values()];
      await Promise.all(followed.map((entry) => entry?.subscription?.release().catch(() => {})));
    },
  };
}
