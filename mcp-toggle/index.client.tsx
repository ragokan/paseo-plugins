import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { contributePills } from "./client/pills";
import { McpScreen } from "./client/screen";

function McpSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Plug" active={currentScreen?.screenId === "mcps"} onPress={() => openScreen({ screenId: "mcps" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "mcps", title: "Manage mcp", Component: McpScreen });
  client.addSidebarHeaderItem({ id: "mcps", title: "Manage mcp", Component: McpSidebarItem });
  return contributePills(client);
}
