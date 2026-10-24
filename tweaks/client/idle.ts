/** How long a workspace Paseo puts in Done waits in Idle first. */
export const IDLE_FOR = 24 * 60 * 60 * 1000;

// The fields of Paseo's status grouping this plugin reads or rewrites.
interface Row {
  workspaceKey: string;
  workspaceId: string;
  statusEnteredAt: Date | null;
}
interface WorkspaceGroup {
  key: string;
  label: string;
  rows: Row[];
  leading: unknown;
}
export interface Projection {
  pinnedGroups: { pinnedChats: Row[] };
  workspaceGroups: WorkspaceGroup[];
  shortcutModel: unknown;
}
export interface GroupingInput {
  groupMode: string;
  pinnedCollapsed: boolean;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
}
export type BuildShortcuts = (input: { sections: Array<{ workspaces: Row[]; collapsed?: boolean }> }) => unknown;

// Paseo's leading icon for its Working group.
const WORKING_ICON = { kind: "status", bucket: "running" };

/** What a workspace marked as done by hand is known by: it stays in Done until its status changes. */
export const doneMark = (workspaceId: string, enteredAt: number) => `${workspaceId}@${enteredAt}`;

/** Whether a workspace in Done since enteredAt waits in Idle now. */
export function waitsInIdle(workspaceId: string, enteredAt: number | undefined, now: number, done: ReadonlySet<string>) {
  return enteredAt !== undefined && now - enteredAt < IDLE_FOR && !done.has(doneMark(workspaceId, enteredAt));
}

/**
 * In status grouping, moves the workspaces in Done waiting on a subagent into a Waiting group, then
 * those that entered Done less than a day ago, and were not marked as done by hand, into an Idle
 * group, both just above Done. Paseo lists Done newest first, so they leave it in its order. Returns
 * when the next workspace in Idle turns Done, or null when none waits.
 */
export function splitIdle<Result extends Projection>(
  projection: Result,
  input: GroupingInput,
  now: number,
  done: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
  buildShortcuts?: BuildShortcuts,
): { projection: Result; turnsDoneAt: number | null } {
  const unchanged = { projection, turnsDoneAt: null };
  if (input.groupMode !== "status") return unchanged;
  const index = projection.workspaceGroups.findIndex((group) => group.key === "done");
  if (index < 0) return unchanged;
  const doneGroup = projection.workspaceGroups[index]!;
  const subagents: Row[] = [];
  const idle: Row[] = [];
  const rest: Row[] = [];
  let turnsDoneAt: number | null = null;
  for (const row of doneGroup.rows) {
    if (waiting.has(row.workspaceId)) {
      subagents.push(row);
      continue;
    }
    const enteredAt = row.statusEnteredAt?.getTime();
    if (!waitsInIdle(row.workspaceId, enteredAt, now, done)) {
      rest.push(row);
      continue;
    }
    idle.push(row);
    turnsDoneAt = Math.min(turnsDoneAt ?? Infinity, enteredAt! + IDLE_FOR);
  }
  if (subagents.length === 0 && idle.length === 0) return unchanged;
  // Waiting has Working's icon, Idle has Done's; each collapses on its own, under its own key.
  const groups = [
    ...projection.workspaceGroups.slice(0, index),
    ...(subagents.length > 0 ? [{ ...doneGroup, key: "waiting", label: "Waiting", leading: WORKING_ICON, rows: subagents }] : []),
    ...(idle.length > 0 ? [{ ...doneGroup, key: "idle", label: "Idle", rows: idle }] : []),
    ...(rest.length > 0 ? [{ ...doneGroup, rows: rest }] : []),
    ...projection.workspaceGroups.slice(index + 1),
  ];
  // Keyboard shortcuts number the rows top to bottom, skipping collapsed groups, as Paseo does.
  const shortcutModel = buildShortcuts
    ? buildShortcuts({
        sections: [
          ...(input.pinnedCollapsed ? [] : [{ workspaces: projection.pinnedGroups.pinnedChats }]),
          ...groups.map((group) => ({ workspaces: group.rows, collapsed: input.collapsedWorkspaceGroupKeys.has(group.key) })),
        ],
      })
    : projection.shortcutModel;
  return { projection: { ...projection, workspaceGroups: groups, shortcutModel }, turnsDoneAt };
}
