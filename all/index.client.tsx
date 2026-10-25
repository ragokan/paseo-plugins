import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { joinAppFeatures, whileAppFeature } from "./client/app-features";
import { FeatureSettings } from "./client/settings";
import { createSwitches, type Contribution } from "./client/switches";
import { joinWorkspaceSettings } from "./client/plugins/tweaks/hosts";
import { contributeApp as tweaks, contributeEveryCopy } from "./client/plugins/tweaks/index";
import machineStatus from "./client/plugins/machine-status/index";
import markAllRead from "./client/plugins/mark-all-read/index";
import mcpToggle from "./client/plugins/mcp-toggle/index";
import mergeThinking from "./client/plugins/merge-thinking/index";
import themes from "./client/plugins/themes/index";
import { DEFAULT_HOST_FEATURES, hostFeatureSettings, type AppFeatureId, type HostFeatureId } from "./shared/features";

declare const console: { warn(...args: unknown[]): void };

const APP_CONTRIBUTIONS: Record<AppFeatureId, Contribution> = {
  "mark-all-read": markAllRead,
  "merge-thinking": mergeThinking,
  themes,
  tweaks,
};
const HOST_CONTRIBUTIONS: Record<HostFeatureId, Contribution> = {
  "mcp-toggle": mcpToggle,
  "machine-status": machineStatus,
  // Daemon only: it resumes agents on its own host and adds nothing to the app.
  "continue-after-error": () => {},
  // Daemon only: it labels its own host's workspaces, which the app shows like any label.
  "status-labels": () => {},
  // Daemon only: it renames its own host's agents, which the app shows like any title.
  "agent-titles": () => {},
};
const hostSettings = hostFeatureSettings(false);

export default function contribute(client: PluginClientContext) {
  // Every copy brings its host's hidden workspaces and those marked as done, whichever copy runs the tweaks' sidebar patch.
  const leaveWorkspaces = joinWorkspaceSettings(client);
  // Paseo offers a copy's commands only on its own host's workspaces, so every copy adds Mark as
  // done, and follows its own host's agents for Waiting.
  const stopTweaks = whileAppFeature("tweaks", () => contributeEveryCopy(client));
  const leaveApp = joinAppFeatures(client, APP_CONTRIBUTIONS);
  const hostSwitches = createSwitches(client, HOST_CONTRIBUTIONS);

  client.rpc(settingsRpc(hostSettings.id).read, {}).then(
    (state) => {
      const parsed = state.status === "ready" ? hostSettings.schema.safeParse(state.values) : null;
      if (!parsed?.success) console.warn("[all] this host's switches are unreadable; using the defaults", state);
      void hostSwitches.apply(parsed?.success ? parsed.data : DEFAULT_HOST_FEATURES);
    },
    (error: unknown) => {
      console.warn("[all] could not read this host's switches; using the defaults", error);
      void hostSwitches.apply(DEFAULT_HOST_FEATURES);
    },
  );

  // Another open app picks up a host switch when it reloads; this one applies it as soon as it saves.
  const FeatureSettingsScreen = (props: PluginSurfaceProps) => <FeatureSettings {...props} onHostChange={hostSwitches.apply} />;
  client.addSettingsScreen({ id: "features", title: "Features", icon: "ToggleRight", Component: FeatureSettingsScreen });

  return async () => {
    await hostSwitches.dispose();
    await leaveApp();
    stopTweaks();
    leaveWorkspaces();
  };
}
