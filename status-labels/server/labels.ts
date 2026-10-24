/**
 * The label for each group of the sidebar grouped by status, with its color: Paseo's statuses, then
 * the groups hide-workspaces splits off Done. Paseo's label colors have no gray, so Done is indigo.
 */
export const LABELS = {
  // Paseo's Needs input: an agent asks a question or waits for a permission.
  Input: "orange",
  Failed: "red",
  Working: "blue",
  // Paseo's Ready to review.
  Review: "emerald",
  // In Done while an agent waits on a subagent.
  Waiting: "sky",
  // In Done for less than a day and not marked as done.
  Idle: "amber",
  Done: "indigo",
} as const;
export type LabelName = keyof typeof LABELS;
export type LabelColor = (typeof LABELS)[LabelName];

const BY_STATUS: Readonly<Record<string, LabelName>> = { needs_input: "Input", failed: "Failed", running: "Working", attention: "Review" };

/** How long a workspace Paseo puts in Done waits in Idle first, as in hide-workspaces. */
export const IDLE_FOR = 24 * 60 * 60 * 1000;

// The fields of Paseo's workspace and agent snapshots this plugin reads.
export interface Workspace {
  id: string;
  status: string;
  statusEnteredAt?: string | null;
  labels?: readonly string[];
}
export interface Agent {
  workspaceId?: string | null;
  parentId: string | null;
  working: boolean;
}

/** hide-workspaces' marks: a workspace marked as done in Idle, by id, with when it entered Done. */
export type DoneMarks = Readonly<Record<string, number>>;

// Paseo matches label names this way, so "done" is the same label as "Done".
const key = (name: string) => name.replace(/\s+/g, " ").trim().toLowerCase();
const MANAGED = new Map(Object.keys(LABELS).map((name) => [key(name), name as LabelName]));

/** The managed label a name stands for, if it is one. */
export const managedLabel = (name: string): LabelName | undefined => MANAGED.get(key(name));

/** When a workspace in Done entered it, if it still waits in Idle at now. */
function idleSince(workspace: Workspace, now: number, done: DoneMarks): number | null {
  const enteredAt = workspace.statusEnteredAt ? Date.parse(workspace.statusEnteredAt) : NaN;
  if (Number.isNaN(enteredAt) || now - enteredAt >= IDLE_FOR || done[workspace.id] === enteredAt) return null;
  return enteredAt;
}

/** The label of the group the sidebar shows a workspace in, or null for a status this plugin does not know. */
export function labelFor(workspace: Workspace, now: number, waiting: ReadonlySet<string>, done: DoneMarks): LabelName | null {
  const label = BY_STATUS[workspace.status];
  if (label) return label;
  if (workspace.status !== "done") return null;
  if (waiting.has(workspace.id)) return "Waiting";
  return idleSince(workspace, now, done) === null ? "Done" : "Idle";
}

/** When the next workspace in Idle turns Done, or null when none waits. */
export function nextIdleEnd(workspaces: Iterable<Workspace>, now: number, waiting: ReadonlySet<string>, done: DoneMarks): number | null {
  let next: number | null = null;
  for (const workspace of workspaces) {
    if (workspace.status !== "done" || waiting.has(workspace.id)) continue;
    const enteredAt = idleSince(workspace, now, done);
    if (enteredAt !== null) next = Math.min(next ?? Infinity, enteredAt + IDLE_FOR);
  }
  return next;
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

/** What to take off a workspace and put on it so that, of this plugin's labels, it carries only wanted. Other labels stay. */
export function labelChanges(current: readonly string[], wanted: LabelName | null): { remove: string[]; add: LabelName | null } {
  const remove = current.filter((name) => {
    const managed = managedLabel(name);
    return managed !== undefined && managed !== wanted;
  });
  const add = wanted !== null && !current.some((name) => managedLabel(name) === wanted) ? wanted : null;
  return { remove, add };
}
