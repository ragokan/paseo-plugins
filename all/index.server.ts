import type { PluginServerContext } from "@getpaseo/plugin/server";
import { gate } from "./server/gate";
import agentTitles from "./server/plugins/agent-titles/index";
import continueAfterError from "./server/plugins/continue-after-error/index";
import machineStatus from "./server/plugins/machine-status/index";
import mcpToggle from "./server/plugins/mcp-toggle/index";
import statusLabels from "./server/plugins/status-labels/index";
import { registerWorkspaceSettings } from "./server/plugins/tweaks/index";
import { hostFeatureSettings, type HostFeatures } from "./shared/features";

export default function contribute(server: PluginServerContext) {
  const linux = process.platform === "linux";
  const settings = server.registerSettings(hostFeatureSettings(linux));
  let features: HostFeatures = { "mcp-toggle": true, "machine-status": linux, "continue-after-error": true, "status-labels": true, "agent-titles": true };
  const update = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") features = state.values;
    else console.warn("[all] Features settings are unreadable; keeping the previous switches:", state.error);
  };
  const firstRead = settings.read().then(update, (error: unknown) => console.warn("[all] could not read the Features settings:", error));
  const unsubscribe = settings.subscribe(update);
  // Only keeps the hidden workspaces and those marked as done in this host's settings; its switch is in the app.
  const workspaces = registerWorkspaceSettings(server);

  const cleanups = [
    mcpToggle(gate(server, "mcp-toggle", () => features["mcp-toggle"])),
    machineStatus(gate(server, "machine-status", () => features["machine-status"])),
    // Its resume runs once, as the daemon starts, so it waits for this host's switch.
    continueAfterError(gate(server, "continue-after-error", () => features["continue-after-error"]), {
      enabled: async () => {
        await firstRead;
        return features["continue-after-error"];
      },
    }),
    // Registers nothing, so needs no gate; while it is off it takes its labels off. It follows the tweaks'
    // marks, so a workspace marked as done leaves Idle.
    statusLabels(server, {
      enabled: () => features["status-labels"],
      onChange: (listener) => {
        const stopFeatures = settings.subscribe(() => listener());
        const stopMarks = workspaces.subscribe(() => listener());
        return () => {
          void stopFeatures();
          void stopMarks();
        };
      },
      doneMarks: async () => {
        const state = await workspaces.read();
        return state.status === "ready" ? state.values.done : {};
      },
    }),
    agentTitles(gate(server, "agent-titles", () => features["agent-titles"])),
  ];

  return async () => {
    unsubscribe();
    for (const cleanup of cleanups) await cleanup();
  };
}
