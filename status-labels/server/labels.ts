/**
 * The label for each group of the sidebar grouped by status, with its color: Paseo's statuses, then
 * the groups the tweaks plugin splits off Done. Paseo's label colors have no gray, so Done is indigo.
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

/** How long a workspace Paseo puts in Done waits in Idle first, as in the tweaks plugin. */
export const IDLE_FOR = 24 * 60 * 60 * 1000;

// The fields of Paseo's workspace and agent snapshots this plugin reads.
export interface Workspace {
  id: string;
  status: string;
  statusEnteredAt?: string | null;
  lastUserMessageAt?: string | null;
  labels?: readonly string[];
}
export interface Agent {
  workspaceId?: string | null;
  parentId: string | null;
  working: boolean;
}

/** The tweaks plugin's marks: a workspace marked as done in Idle, by id, with when it entered Done. */
export type DoneMarks = Readonly<Record<string, number>>;
/** When each workspace this plugin has seen entered Done, by id; null while it is in another status. */
export type DoneSince = Readonly<Record<string, number | null>>;

// The app and this plugin each stamp a workspace's entry into Done themselves, a moment apart.
const SAME_STAY = 60_000;

// Paseo matches label names this way, so "done" is the same label as "Done".
const key = (name: string) => name.replace(/\s+/g, " ").trim().toLowerCase();
const MANAGED = new Map(Object.keys(LABELS).map((name) => [key(name), name as LabelName]));

/** The managed label a name stands for, if it is one. */
export const managedLabel = (name: string): LabelName | undefined => MANAGED.get(key(name));

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * When each workspace in Done entered it. Paseo works statusEnteredAt out again for every connection,
 * from its agents' last update, so a daemon restart or a reopened chat moves it later, while the app's
 * connection keeps the time it saw. So this keeps the earliest time seen for a stay in Done, which ends
 * when the workspace leaves Done or gets a message from you. A workspace it has never seen starts from
 * the tweaks plugin's mark, the app's time, if it has one for this stay.
 */
export function doneSince(previous: DoneSince, workspaces: Iterable<Workspace>, marks: DoneMarks): Record<string, number | null> {
  const next: Record<string, number | null> = {};
  for (const workspace of workspaces) {
    if (workspace.status !== "done") {
      next[workspace.id] = null;
      continue;
    }
    const before = previous[workspace.id];
    const earlier = before === undefined ? marks[workspace.id] : (before ?? undefined);
    const kept = earlier !== undefined && !(time(workspace.lastUserMessageAt) > earlier) ? earlier : undefined;
    const at = time(workspace.statusEnteredAt);
    next[workspace.id] = Number.isNaN(at) ? (kept ?? null) : Math.min(kept ?? at, at);
  }
  return next;
}

/** When a workspace in Done entered it, if it still waits in Idle at now. */
function idleSince(workspace: Workspace, now: number, since: DoneSince, done: DoneMarks): number | null {
  const enteredAt = since[workspace.id];
  if (enteredAt == null || now - enteredAt >= IDLE_FOR) return null;
  const mark = done[workspace.id];
  return mark !== undefined && Math.abs(mark - enteredAt) < SAME_STAY ? null : enteredAt;
}

/** The label of the group the sidebar shows a workspace in, or null for a status this plugin does not know. */
export function labelFor(workspace: Workspace, now: number, waiting: ReadonlySet<string>, since: DoneSince, done: DoneMarks): LabelName | null {
  const label = BY_STATUS[workspace.status];
  if (label) return label;
  if (workspace.status !== "done") return null;
  if (waiting.has(workspace.id)) return "Waiting";
  return idleSince(workspace, now, since, done) === null ? "Done" : "Idle";
}

/** When the next workspace in Idle turns Done, or null when none waits. */
export function nextIdleEnd(
  workspaces: Iterable<Workspace>,
  now: number,
  waiting: ReadonlySet<string>,
  since: DoneSince,
  done: DoneMarks,
): number | null {
  let next: number | null = null;
  for (const workspace of workspaces) {
    if (workspace.status !== "done" || waiting.has(workspace.id)) continue;
    const enteredAt = idleSince(workspace, now, since, done);
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
