import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useHosts } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { contributePills } from "./client/pills";
import { McpScreen } from "./client/screen";

const TITLE = "Manage MCP servers";

function McpSidebarItem({ currentScreen, host, openScreen }: PluginSidebarItemProps) {
  // Each host with this plugin adds a row and switches its own servers, so the rows name their host.
  const label = useHosts().length > 1 ? `${TITLE} · ${host.label}` : undefined;
  return <SidebarRow icon="Plug" label={label} active={currentScreen?.screenId === "mcps"} onPress={() => openScreen({ screenId: "mcps" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "mcps", title: TITLE, Component: McpScreen });
  client.addSidebarHeaderItem({ id: "mcps", title: TITLE, Component: McpSidebarItem });
  return contributePills(client);
}
