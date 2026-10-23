import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// One switch per bundled plugin, worded like the plugin's own paseo-plugin.json. "app" plugins change
// the app itself, so one copy runs them however many hosts have this plugin, and their switches are
// saved in the app. "host" plugins act on the host they are installed on, so each host runs its own,
// switched from that host's settings.
export const FEATURES = [
  { id: "host-filter", scope: "app", title: "Host filter", hint: "Pick which host the sidebar shows, from the top of the sidebar" },
  { id: "mark-all-read", scope: "app", title: "Mark all as read", hint: "A command palette action that marks every agent on every host as read" },
  { id: "merge-projects", scope: "app", title: "Merge projects by name", hint: "Shows same-named projects from different hosts as one sidebar project" },
  { id: "merge-thinking", scope: "app", title: "Merge thinking into tool groups", hint: "Folds thinking rows between tool calls into the collapsed tool call group, and thoughts in a row into one group" },
  { id: "themes", scope: "app", title: "Monokai themes", hint: "Monokai Pro filters as Paseo app themes" },
  { id: "workspace-order", scope: "app", title: "Workspace order", hint: "Keep the sidebar's workspaces in your order, whichever hosts it shows, hide the ones you pick, and hold new Done ones in Stale for a day" },
  {
    id: "mcp-toggle",
    scope: "host",
    title: "MCP toggle",
    hint: "Turn Claude's and Codex's MCP servers on or off, from the sidebar before a session or from a chat's composer",
  },
  { id: "machine-status", scope: "host", title: "Machine status", hint: "CPU, memory, disk, ports, processes and Docker for a Linux host" },
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
    schema: z.object({ "mcp-toggle": z.boolean().default(true), "machine-status": z.boolean().default(linux) }),
  });
}

/** What the app uses when it cannot read a host's switches. */
export const DEFAULT_HOST_FEATURES: HostFeatures = { "mcp-toggle": true, "machine-status": false };
