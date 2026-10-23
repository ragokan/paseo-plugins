import type { PluginServerContext } from "@getpaseo/plugin/server";
import { gate } from "./server/gate";
import hideWorkspaces from "./server/plugins/hide-workspaces/index";
import machineStatus from "./server/plugins/machine-status/index";
import mcpToggle from "./server/plugins/mcp-toggle/index";
import { hostFeatureSettings, type HostFeatures } from "./shared/features";

export default function contribute(server: PluginServerContext) {
  const linux = process.platform === "linux";
  const settings = server.registerSettings(hostFeatureSettings(linux));
  let features: HostFeatures = { "mcp-toggle": true, "machine-status": linux };
  const update = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") features = state.values;
    else console.warn("[all] Features settings are unreadable; keeping the previous switches:", state.error);
  };
  settings.read().then(update, (error: unknown) => console.warn("[all] could not read the Features settings:", error));
  const unsubscribe = settings.subscribe(update);

  const cleanups = [
    mcpToggle(gate(server, "mcp-toggle", () => features["mcp-toggle"])),
    machineStatus(gate(server, "machine-status", () => features["machine-status"])),
    // Only keeps the hidden workspaces and those marked as done in this host's settings; its switch is in the app.
    hideWorkspaces(server),
  ];

  return async () => {
    unsubscribe();
    for (const cleanup of cleanups) await cleanup();
  };
}
