import type { PluginServerContext } from "@getpaseo/plugin/server";
import { workspaceSettings } from "./shared/workspaces";

// Only the order and hidden workspaces live on the host; the app reads and writes them through Paseo's settings RPC.
export default function contribute(server: PluginServerContext) {
  server.registerSettings(workspaceSettings);
  return () => {};
}
