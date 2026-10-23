/** How long a workspace Paseo puts in Done waits in Stale first. */
export const STALE_FOR = 24 * 60 * 60 * 1000;

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

/** What a workspace moved to Done by hand is known by: it stays there until its status changes. */
export const doneMark = (workspaceId: string, enteredAt: number) => `${workspaceId}@${enteredAt}`;

/** Whether a workspace in Done since enteredAt waits in Stale now. */
export function waitsInStale(workspaceId: string, enteredAt: number | undefined, now: number, done: ReadonlySet<string>) {
  return enteredAt !== undefined && now - enteredAt < STALE_FOR && !done.has(doneMark(workspaceId, enteredAt));
}

/**
 * In status grouping, moves the workspaces that entered Done less than a day ago, and were not moved
 * on by hand, into a Stale group just above Done. Paseo lists Done newest first, so they leave it in
 * its order. Returns when the next of them turns Done, or null when none waits.
 */
export function splitStale<Result extends Projection>(
  projection: Result,
  input: GroupingInput,
  now: number,
  done: ReadonlySet<string>,
  buildShortcuts?: BuildShortcuts,
): { projection: Result; turnsDoneAt: number | null } {
  const unchanged = { projection, turnsDoneAt: null };
  if (input.groupMode !== "status") return unchanged;
  const index = projection.workspaceGroups.findIndex((group) => group.key === "done");
  if (index < 0) return unchanged;
  const doneGroup = projection.workspaceGroups[index]!;
  const stale: Row[] = [];
  const rest: Row[] = [];
  let turnsDoneAt: number | null = null;
  for (const row of doneGroup.rows) {
    const enteredAt = row.statusEnteredAt?.getTime();
    if (!waitsInStale(row.workspaceId, enteredAt, now, done)) {
      rest.push(row);
      continue;
    }
    stale.push(row);
    turnsDoneAt = Math.min(turnsDoneAt ?? Infinity, enteredAt! + STALE_FOR);
  }
  if (stale.length === 0) return unchanged;
  // Same icon as Done; Stale collapses on its own, under its own key.
  const groups = [
    ...projection.workspaceGroups.slice(0, index),
    { ...doneGroup, key: "stale", label: "Stale", rows: stale },
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
