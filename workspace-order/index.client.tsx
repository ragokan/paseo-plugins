import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Platform } from "react-native";
import { WorkspaceOrderScreen, WorkspaceOrderSettings } from "./client/screen";
import { findSidebarModules, patch } from "./client/sidebar";

declare const console: { warn(...args: unknown[]): void };

const SCREEN_ID = "workspace-order";
const TITLE = "Organize Workspace Order";

function WorkspaceOrderSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow icon="ListOrdered" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />
  );
}

export default function contribute(client: PluginClientContext) {
  // The sidebar patch reads the web bundle, so iOS and Android get nothing; an order there would not apply.
  if (Platform.OS !== "web") return () => {};
  client.addScreen({ id: SCREEN_ID, title: TITLE, Component: WorkspaceOrderScreen });
  client.addSidebarHeaderItem({ id: SCREEN_ID, title: TITLE, Component: WorkspaceOrderSidebarItem });
  client.addSettingsScreen({ id: SCREEN_ID, title: TITLE, icon: "ListOrdered", Component: WorkspaceOrderSettings });
  const unpatch = findSidebarModules().then(patch, (error) => {
    console.warn("[workspace-order]", error);
    return () => {};
  });
  return async () => (await unpatch)();
}
