import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { FeatureSettings } from "./client/settings";
import { createSwitches } from "./client/switches";
import hostFilter from "./client/plugins/host-filter/index";
import machineStatus from "./client/plugins/machine-status/index";
import markAllRead from "./client/plugins/mark-all-read/index";
import mcpToggle from "./client/plugins/mcp-toggle/index";
import mergeProjects from "./client/plugins/merge-projects/index";
import mergeThinking from "./client/plugins/merge-thinking/index";
import themes from "./client/plugins/themes/index";
import workspaceOrder from "./client/plugins/workspace-order/index";
import { DEFAULT_FEATURES, featureSettings, type FeatureId } from "./shared/features";

declare const console: { warn(...args: unknown[]): void };

const CONTRIBUTIONS: Record<FeatureId, typeof hostFilter> = {
  "host-filter": hostFilter,
  "mark-all-read": markAllRead,
  "mcp-toggle": mcpToggle,
  "merge-projects": mergeProjects,
  "merge-thinking": mergeThinking,
  themes,
  "workspace-order": workspaceOrder,
  "machine-status": machineStatus,
};

export default function contribute(client: PluginClientContext) {
  const switches = createSwitches(client, CONTRIBUTIONS);

  client.rpc(settingsRpc(featureSettings.id).read, {}).then(
    (state) => {
      const parsed = state.status === "ready" ? featureSettings.schema.safeParse(state.values) : null;
      if (!parsed?.success) console.warn("[all] Features settings are unreadable; using the defaults", state);
      void switches.apply(parsed?.success ? parsed.data : DEFAULT_FEATURES);
    },
    (error: unknown) => {
      console.warn("[all] could not read the Features settings; using the defaults", error);
      void switches.apply(DEFAULT_FEATURES);
    },
  );

  // Another open app picks up a change when it reloads; this one applies it as soon as it saves.
  const FeatureSettingsScreen = (props: PluginSurfaceProps) => <FeatureSettings {...props} onChange={switches.apply} />;
  client.addSettingsScreen({ id: "features", title: "Features", icon: "ToggleRight", Component: FeatureSettingsScreen });

  return () => switches.dispose();
}
