import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { joinAgents, readWaiting } from "./client/agents";
import { joinWorkspaceSettings, markDone, readDone } from "./client/hosts";
import { waitsInIdle } from "./client/idle";
import { HideWorkspacesSettings } from "./client/screen";
import { findSidebarModules, metroModules, patch } from "./client/sidebar";
import { applyTweaks } from "./client/tweaks";
import { stylePage } from "./client/web";

declare const console: { warn(...args: unknown[]): void };
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/**
 * What changes the app itself: the sidebar patch, the host badges and the New workspace form, the
 * page styles for Idle's icon and the Done label, and on desktop and web the settings page that
 * hides workspaces.
 */
export function contributeApp(client: PluginClientContext) {
  // The page is desktop and web only; the iOS and Android apps follow the hidden workspaces the hosts keep.
  if (Platform.OS === "web") {
    client.addSettingsScreen({ id: "hide-workspaces", title: "Hide Workspaces", icon: "EyeOff", Component: HideWorkspacesSettings });
  }
  const unstyle = stylePage();
  let unpatch: (() => void) | undefined;
  let untweak: (() => void) | undefined;
  let retry: unknown;
  let attempts = 0;
  // The sidebar modules may not have loaded yet when the plugin starts, so look again for a while.
  const attach = () => {
    try {
      const modules = metroModules();
      untweak ??= applyTweaks(modules);
      unpatch = patch(findSidebarModules(modules));
    } catch (error) {
      if (++attempts < 30) retry = setTimeout(attach, 1000);
      else console.warn("[tweaks]", error);
    }
  };
  attach();
  return () => {
    clearTimeout(retry);
    unpatch?.();
    untweak?.();
    unstyle();
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
      const inIdle = waitsInIdle(workspace.id, enteredAt, Date.now(), readDone()) && !readWaiting().has(workspace.id);
      if (workspace.status !== "done" || !inIdle) {
        throw new Error("This workspace is not in Idle");
      }
      return markDone(client, workspace.id, enteredAt!);
    },
  });
}

/**
 * What every copy adds for its own host, whichever copy runs the sidebar patch: Mark as done, and the
 * host's agents, for Waiting.
 */
export function contributeEveryCopy(client: PluginClientContext) {
  const removeMarkAsDone = addMarkAsDone(client);
  const leaveAgents = joinAgents(client);
  return () => {
    leaveAgents();
    removeMarkAsDone();
  };
}

export default function contribute(client: PluginClientContext) {
  const leaveHosts = joinWorkspaceSettings(client);
  const stopEveryCopy = contributeEveryCopy(client);
  const stopApp = contributeApp(client);
  return () => {
    stopApp();
    stopEveryCopy();
    leaveHosts();
  };
}
