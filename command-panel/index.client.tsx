import type { PluginClientContext } from "@getpaseo/plugin/client";
import { findAppModules } from "./client/app";
import { startUpdates, UpdatesScreen } from "./client/screen";
import { addSidebarCommands } from "./client/sidebar";

declare const console: { warn(...args: unknown[]): void };

/**
 * The plugins' sidebar rows and Update All Plugins in the command palette. Paseo offers a copy's
 * commands only while its own host is selected, so every copy adds them.
 */
export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({ id: "updates", title: "Plugin updates", Component: UpdatesScreen });
  const removeUpdate = client.addCommandCenterItem({
    id: "update-all-plugins",
    title: "Update All Plugins",
    icon: "RefreshCw",
    keywords: ["plugins", "update", "upgrade", "extensions", "hosts"],
    context: "global",
    onSelect({ openScreen }) {
      startUpdates();
      openScreen({ screenId: "updates" });
    },
  });
  let removeSidebar = () => {};
  try {
    removeSidebar = addSidebarCommands(client, findAppModules());
  } catch (error) {
    console.warn("[command-panel] sidebar rows stay out of the command palette:", error);
  }
  return () => {
    removeSidebar();
    removeUpdate();
    removeScreen();
  };
}
