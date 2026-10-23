import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { joinWorkspaceSettings, markDone, readDone } from "./client/hosts";
import { waitsInIdle } from "./client/idle";
import { HideWorkspacesSettings } from "./client/screen";
import { findSidebarModules, patch } from "./client/sidebar";

declare const console: { warn(...args: unknown[]): void };
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** The sidebar patch, plus on desktop and web the settings page that hides workspaces. */
export function contributeSidebar(client: PluginClientContext) {
  // The page is desktop and web only; the iOS and Android apps follow the hidden workspaces the hosts keep.
  if (Platform.OS === "web") {
    client.addSettingsScreen({ id: "hide-workspaces", title: "Hide Workspaces", icon: "EyeOff", Component: HideWorkspacesSettings });
  }
  let unpatch: (() => void) | undefined;
  let retry: unknown;
  let attempts = 0;
  // The sidebar modules may not have loaded yet when the plugin starts, so look again for a while.
  const attach = () => {
    try {
      unpatch = patch(findSidebarModules());
    } catch (error) {
      if (++attempts < 30) retry = setTimeout(attach, 1000);
      else console.warn("[hide-workspaces]", error);
    }
  };
  attach();
  return () => {
    clearTimeout(retry);
    unpatch?.();
  };
}

/**
 * "Mark as done" in the command palette sends the open workspace from Idle to Done. Paseo offers a
 * copy's commands only on its own host's workspaces, so every copy adds it.
 */
export function addMarkAsDone(client: PluginClientContext) {
  return client.addCommandCenterItem({
    id: "mark-as-done",
    title: "Mark as done",
    icon: "CircleCheck",
    keywords: ["idle", "done", "status", "sidebar"],
    context: "workspace",
    onSelect: ({ workspace }) => {
      const enteredAt = workspace.statusEnteredAt === null ? undefined : Date.parse(workspace.statusEnteredAt);
      // Paseo shows the error in a toast.
      if (workspace.status !== "done" || !waitsInIdle(workspace.id, enteredAt, Date.now(), readDone())) {
        throw new Error("This workspace is not in Idle");
      }
      return markDone(client, workspace.id, enteredAt!);
    },
  });
}

export default function contribute(client: PluginClientContext) {
  const leaveHosts = joinWorkspaceSettings(client);
  const removeMarkAsDone = addMarkAsDone(client);
  const stopSidebar = contributeSidebar(client);
  return () => {
    stopSidebar();
    removeMarkAsDone();
    leaveHosts();
  };
}
