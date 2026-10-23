import type { PluginClientContext } from "@getpaseo/plugin/client";
import { getPaseoClient } from "@getpaseo/plugin/client";

interface HostRuntimeStore {
  getHosts(): readonly { serverId: string; label: string }[];
  getSnapshot(serverId: string): {
    connectionStatus: string;
    client: { clearWorkspaceAttention(workspaceIds: string[]): Promise<void> } | null;
  } | null;
}

// shortcut: the plugin SDK lists agents but cannot clear their attention, so this borrows the
// app's host runtime store, a singleton on globalThis, for each host's own daemon client. That
// client's clearWorkspaceAttention is what the sidebar's "Mark as read" calls. Breaks if Paseo
// renames the global or these methods; switch to an SDK call once one exists.
export function findHostRuntimeStore(): HostRuntimeStore {
  const store = Reflect.get(globalThis, "__paseoHostRuntimeStore") as Partial<HostRuntimeStore> | undefined;
  if (typeof store?.getHosts !== "function" || typeof store.getSnapshot !== "function") {
    throw new Error("Paseo host runtime not found");
  }
  return store as HostRuntimeStore;
}

// Workspace status shows only its most urgent agent, so a running or waiting agent hides an
// unread one; look at agents instead. Skip the ones the daemon keeps: those waiting on a permission.
async function unreadWorkspaceIds(serverId: string) {
  const { agents } = getPaseoClient(serverId);
  const unread = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await agents.list({
      includeBackground: true,
      filter: { requiresAttention: true },
      page: { limit: 200, cursor },
    });
    for (const { agent } of page.entries) {
      if (!agent.workspaceId || agent.archivedAt) continue;
      if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") continue;
      unread.add(agent.workspaceId);
    }
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  if (unread.size === 0) return [];
  const active = await activeWorkspaceIds(serverId);
  return [...unread].filter((id) => active.has(id));
}

// An agent can outlive its archived workspace. Nothing shows it, and the daemon fails the whole
// request with "Workspace not found", so keep to active workspaces.
async function activeWorkspaceIds(serverId: string) {
  const { workspaces } = getPaseoClient(serverId);
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await workspaces.list({ filter: { includeBackground: true }, page: { limit: 200, cursor } });
    for (const workspace of page.entries) ids.add(workspace.id);
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return ids;
}

// Every configured host at once. Throws after trying them all, so Paseo shows the failed hosts in a toast.
export async function markAllRead(store = findHostRuntimeStore()) {
  const failures: string[] = [];
  await Promise.all(
    store.getHosts().map(async ({ serverId, label }) => {
      try {
        const snapshot = store.getSnapshot(serverId);
        if (snapshot?.connectionStatus !== "online" || !snapshot.client) throw new Error("offline");
        const workspaceIds = await unreadWorkspaceIds(serverId);
        if (workspaceIds.length > 0) await snapshot.client.clearWorkspaceAttention(workspaceIds);
      } catch (error) {
        failures.push(`${label.trim() || serverId} (${error instanceof Error ? error.message : String(error)})`);
      }
    }),
  );
  if (failures.length > 0) throw new Error(`Mark All as Read failed on ${failures.join(", ")}`);
}

export default function contribute(client: PluginClientContext) {
  return client.addCommandCenterItem({
    id: "mark-all-read",
    title: "Mark All as Read",
    icon: "CheckCheck",
    keywords: ["unread", "clear", "attention", "hosts"],
    context: "global",
    onSelect: () => markAllRead(),
  });
}
