import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Platform } from "react-native";
import { joinWorkspaceSettings, markDone, readDone } from "./client/hosts";
import { WorkspaceOrderScreen, WorkspaceOrderSettings } from "./client/screen";
import { findSidebarModules, patch } from "./client/sidebar";
import { waitsInStale } from "./client/stale";

declare const console: { warn(...args: unknown[]): void };
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

const SCREEN_ID = "workspace-order";
const TITLE = "Organize Workspaces";

function WorkspaceOrderSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow icon="ListOrdered" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />
  );
}

/** The sidebar patch, plus on desktop and web the page that orders and hides workspaces. */
export function contributeSidebar(client: PluginClientContext) {
  // The page is desktop and web only; the iOS and Android apps follow the order and hidden
  // workspaces the hosts keep.
  if (Platform.OS === "web") {
    client.addScreen({ id: SCREEN_ID, title: TITLE, Component: WorkspaceOrderScreen });
    client.addSidebarHeaderItem({ id: SCREEN_ID, title: TITLE, Component: WorkspaceOrderSidebarItem });
    client.addSettingsScreen({ id: SCREEN_ID, title: TITLE, icon: "ListOrdered", Component: WorkspaceOrderSettings });
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
      else console.warn("[workspace-order]", error);
    }
  };
  attach();
  return () => {
    clearTimeout(retry);
    unpatch?.();
  };
}

/**
 * "Move to Done" in the command palette sends the open workspace from Stale to Done. Paseo offers a
 * copy's commands only on its own host's workspaces, so every copy adds it.
 */
export function addMoveToDone(client: PluginClientContext) {
  return client.addCommandCenterItem({
    id: "move-to-done",
    title: "Move to Done",
    icon: "CircleCheck",
    keywords: ["stale", "status", "sidebar"],
    context: "workspace",
    onSelect: ({ workspace }) => {
      const enteredAt = workspace.statusEnteredAt === null ? undefined : Date.parse(workspace.statusEnteredAt);
      // Paseo shows the error in a toast.
      if (workspace.status !== "done" || !waitsInStale(workspace.id, enteredAt, Date.now(), readDone())) {
        throw new Error("This workspace is not in Stale");
      }
      return markDone(client, workspace.id, enteredAt!);
    },
  });
}

export default function contribute(client: PluginClientContext) {
  const leaveHosts = joinWorkspaceSettings(client);
  const removeMoveToDone = addMoveToDone(client);
  const stopSidebar = contributeSidebar(client);
  return () => {
    stopSidebar();
    removeMoveToDone();
    leaveHosts();
  };
}
