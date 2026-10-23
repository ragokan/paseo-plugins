import type { PluginServerContext } from "@getpaseo/plugin/server";
import { gate } from "./server/gate";
import machineStatus from "./server/plugins/machine-status/index";
import mcpToggle from "./server/plugins/mcp-toggle/index";
import { DEFAULT_FEATURES, featureSettings, type Features } from "./shared/features";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(featureSettings);
  let features: Features = DEFAULT_FEATURES;
  const update = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") features = state.values;
    else console.warn("[all] Features settings are unreadable; keeping the previous switches:", state.error);
  };
  settings.read().then(update, (error: unknown) => console.warn("[all] could not read the Features settings:", error));
  const unsubscribe = settings.subscribe(update);

  const cleanups = [
    mcpToggle(gate(server, "mcp-toggle", () => features["mcp-toggle"])),
    machineStatus(gate(server, "machine-status", () => features["machine-status"])),
  ];

  return async () => {
    unsubscribe();
    for (const cleanup of cleanups) await cleanup();
  };
}
