import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// One switch per bundled plugin, worded like the plugin's own paseo-plugin.json. "app" plugins change
// the app itself, so one copy runs them however many hosts have this plugin, and their switches are
// saved in the app. "host" plugins act on the host they are installed on, so each host runs its own,
// switched from that host's settings.
export const FEATURES = [
  { id: "mark-all-read", scope: "app", title: "Mark all as read", hint: "A command palette action that marks every agent on every host as read" },
  { id: "merge-thinking", scope: "app", title: "Merge thinking into tool groups", hint: "Folds thinking rows between tool calls into the collapsed tool call group, and thoughts in a row into one group" },
  { id: "themes", scope: "app", title: "Monokai themes", hint: "Monokai Pro filters as Paseo app themes" },
  {
    id: "tweaks",
    scope: "app",
    title: "Tweaks",
    hint: "Hide the sidebar's workspaces you pick, Idle and Waiting groups with Mark as done, Idle's own icon, host names without the server icon, the machine before the folder, and a gray Done label",
  },
  {
    id: "mcp-toggle",
    scope: "host",
    title: "MCP toggle",
    hint: "Turn Claude's and Codex's MCP servers on or off, from the sidebar before a session or from a chat's composer",
  },
  { id: "machine-status", scope: "host", title: "Machine status", hint: "CPU, memory, disk, ports, processes and Docker for a Linux host" },
  {
    id: "continue-after-error",
    scope: "host",
    title: "Continue after error",
    hint: "When the daemon starts, resume the Claude and Codex agents a daemon stop, crash or error cut off, but not the ones you stopped",
    serverOnly: true,
  },
  {
    id: "status-labels",
    scope: "host",
    title: "Status labels",
    hint: "Label each workspace by its sidebar status group: Input, Failed, Working, Review, Waiting, Idle or Done",
    serverOnly: true,
  },
] as const;

type Feature = (typeof FEATURES)[number];
export type AppFeatureId = Extract<Feature, { scope: "app" }>["id"];
export type HostFeatureId = Extract<Feature, { scope: "host" }>["id"];
export type AppFeatures = Record<AppFeatureId, boolean>;
export type HostFeatures = Record<HostFeatureId, boolean>;

export const APP_FEATURES = FEATURES.filter((feature): feature is Extract<Feature, { scope: "app" }> => feature.scope === "app");
export const HOST_FEATURES = FEATURES.filter((feature): feature is Extract<Feature, { scope: "host" }> => feature.scope === "host");

export const DEFAULT_APP_FEATURES = Object.fromEntries(APP_FEATURES.map((feature) => [feature.id, true])) as AppFeatures;

/** The host switches, saved on each host. Machine status reads /proc, so it starts on only on Linux. */
export function hostFeatureSettings(linux: boolean) {
  return defineSettings({
    id: "features",
    scope: "host",
    version: 1,
    schema: z.object({
      "mcp-toggle": z.boolean().default(true),
      "machine-status": z.boolean().default(linux),
      "continue-after-error": z.boolean().default(true),
      "status-labels": z.boolean().default(true),
    }),
  });
}

/** What the app uses when it cannot read a host's switches. */
export const DEFAULT_HOST_FEATURES: HostFeatures = { "mcp-toggle": true, "machine-status": false, "continue-after-error": true, "status-labels": true };
