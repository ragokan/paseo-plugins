import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// One switch per bundled plugin, worded like the plugin's own paseo-plugin.json.
export const FEATURES = [
  { id: "host-filter", title: "Host filter", hint: "Pick which host the sidebar shows, from the top of the sidebar", on: true },
  { id: "mark-all-read", title: "Mark all as read", hint: "A command palette action that marks every agent on every host as read", on: true },
  {
    id: "mcp-toggle",
    title: "MCP toggle",
    hint: "Turn Claude's and Codex's MCP servers on or off, from the sidebar before a session or from a chat's composer",
    on: true,
  },
  { id: "merge-projects", title: "Merge projects by name", hint: "Shows same-named projects from different hosts as one sidebar project", on: true },
  { id: "merge-thinking", title: "Merge thinking into tool groups", hint: "Folds thinking rows between tool calls into the collapsed tool call group", on: true },
  { id: "themes", title: "Monokai themes", hint: "Monokai Pro filters as Paseo app themes", on: true },
  { id: "workspace-order", title: "Workspace order", hint: "Keep the sidebar's workspaces in your order, whichever hosts it shows", on: true },
  // Off by default: it reads /proc and runs Linux tools, so it is only useful on a Linux host.
  { id: "machine-status", title: "Machine status", hint: "CPU, memory, disk, ports, processes and Docker for a Linux host", on: false },
] as const;

export type FeatureId = (typeof FEATURES)[number]["id"];
export type Features = Record<FeatureId, boolean>;

export const featureSettings = defineSettings({
  id: "features",
  scope: "host",
  version: 1,
  schema: z.object(
    Object.fromEntries(FEATURES.map((feature) => [feature.id, z.boolean().default(feature.on)])) as Record<
      FeatureId,
      z.ZodDefault<z.ZodBoolean>
    >,
  ),
});

export const DEFAULT_FEATURES: Features = featureSettings.schema.parse({});
