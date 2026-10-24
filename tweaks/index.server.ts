import type { PluginServerContext } from "@getpaseo/plugin/server";
import { workspaceSettings } from "./shared/workspaces";

/** Registers the hidden workspaces and those marked as done, and hands them back, for the all plugin's status labels. */
export function registerWorkspaceSettings(server: PluginServerContext) {
  return server.registerSettings(workspaceSettings);
}

// Only the hidden workspaces and those marked as done live on the host; the app reads and writes them through Paseo's settings RPC.
export default function contribute(server: PluginServerContext) {
  registerWorkspaceSettings(server);
  return () => {};
}
