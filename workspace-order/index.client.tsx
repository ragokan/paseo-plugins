import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Platform } from "react-native";
import { joinHiddenWorkspaces } from "./client/hidden";
import { WorkspaceOrderScreen, WorkspaceOrderSettings } from "./client/screen";
import { findSidebarModules, patch } from "./client/sidebar";

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
  // The order is saved in the app's localStorage, which iOS and Android plugins lack, so the page is
  // desktop and web only. The phone still hides what the hosts list.
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

export default function contribute(client: PluginClientContext) {
  const leaveHidden = joinHiddenWorkspaces(client);
  const stopSidebar = contributeSidebar(client);
  return () => {
    stopSidebar();
    leaveHidden();
  };
}
