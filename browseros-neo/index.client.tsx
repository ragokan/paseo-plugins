import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BrowserScreen } from "./client/screen.tsx";
import { useReportScreen } from "./client/viewing.ts";

function BrowserSidebarItem({ currentScreen, host, openScreen }: PluginSidebarItemProps) {
  const active = currentScreen?.screenId === "main";
  useReportScreen(host.id, active);
  return <SidebarRow icon="Dog" active={active} onPress={() => openScreen({ screenId: "main" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "BrowserOS Neo", Component: BrowserScreen });
  client.addSidebarHeaderItem({ id: "main", title: "BrowserOS Neo", Component: BrowserSidebarItem });
  client.addCommandCenterItem({
    id: "open-browseros-neo", title: "Open BrowserOS Neo", icon: "Dog", context: "global",
    keywords: ["browser", "remote", "desktop"],
    onSelect(capabilities) { capabilities.openScreen({ screenId: "main" }); },
  });
  return () => {};
}
