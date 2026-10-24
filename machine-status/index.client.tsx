import type { PluginClientContext } from "@getpaseo/plugin/client";
import { openMachineScreen, registerMachineScreen, supportsScreenParams } from "./client/compat.tsx";
import { MachineStatusSurface } from "./client/status.tsx";

/**
 * The app half of the plugin: the Machine screen, the ways into it from the
 * sidebar and the Command Center. No composer pill: it kept every connected app
 * polling the daemon whenever an agent existed.
 */
export default function contribute(client: PluginClientContext) {
  registerMachineScreen(client, MachineStatusSurface);

  client.addCommandCenterItem({
    id: "open-machine-status",
    title: "Machine status",
    icon: "Activity",
    keywords: ["cpu", "memory", "disk", "swap", "processes", "ports", "services", "linux", "macos"],
    context: "global",
    onSelect(capabilities) {
      openMachineScreen(capabilities);
    },
  });

  // Straight to a tab needs screen params. On older apps these would open the
  // overview under a misleading title, so they are not offered there.
  if (supportsScreenParams(client)) {
    client.addCommandCenterItem({
      id: "open-machine-services",
      title: "Machine: ports & services",
      icon: "Network",
      keywords: ["ports", "listening", "ss", "lsof", "dev server"],
      context: "global",
      onSelect(capabilities) {
        openMachineScreen(capabilities, { tab: "services" });
      },
    });
    client.addCommandCenterItem({
      id: "open-machine-docker",
      title: "Machine: Docker",
      icon: "Container",
      keywords: ["docker", "containers", "images"],
      context: "global",
      onSelect(capabilities) {
        openMachineScreen(capabilities, { tab: "docker" });
      },
    });
  }

  // Paseo removes the screen and command center items itself; nothing else to release.
  return () => {};
}
