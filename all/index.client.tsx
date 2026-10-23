import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { joinAppFeatures } from "./client/app-features";
import { FeatureSettings } from "./client/settings";
import { createSwitches, type Contribution } from "./client/switches";
import hostFilter from "./client/plugins/host-filter/index";
import machineStatus from "./client/plugins/machine-status/index";
import markAllRead from "./client/plugins/mark-all-read/index";
import mcpToggle from "./client/plugins/mcp-toggle/index";
import mergeProjects from "./client/plugins/merge-projects/index";
import mergeThinking from "./client/plugins/merge-thinking/index";
import themes from "./client/plugins/themes/index";
import { joinWorkspaceSettings } from "./client/plugins/workspace-order/hosts";
import { contributeSidebar as workspaceOrder } from "./client/plugins/workspace-order/index";
import { DEFAULT_HOST_FEATURES, hostFeatureSettings, type AppFeatureId, type HostFeatureId } from "./shared/features";

declare const console: { warn(...args: unknown[]): void };

const APP_CONTRIBUTIONS: Record<AppFeatureId, Contribution> = {
  "host-filter": hostFilter,
  "mark-all-read": markAllRead,
  "merge-projects": mergeProjects,
  "merge-thinking": mergeThinking,
  themes,
  "workspace-order": workspaceOrder,
};
const HOST_CONTRIBUTIONS: Record<HostFeatureId, Contribution> = {
  "mcp-toggle": mcpToggle,
  "machine-status": machineStatus,
};
const hostSettings = hostFeatureSettings(false);

export default function contribute(client: PluginClientContext) {
  // Every copy brings its host's workspace order and hidden workspaces, whichever copy runs workspace-order's sidebar patch.
  const leaveWorkspaces = joinWorkspaceSettings(client);
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
    leaveWorkspaces();
  };
}
