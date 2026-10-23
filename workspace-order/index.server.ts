import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hiddenWorkspacesSettings } from "./shared/hidden";

// Only the hidden workspaces live on the host; the app reads and writes them through Paseo's settings RPC.
export default function contribute(server: PluginServerContext) {
  server.registerSettings(hiddenWorkspacesSettings);
  return () => {};
}
