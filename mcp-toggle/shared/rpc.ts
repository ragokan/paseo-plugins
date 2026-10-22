import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** `user`: Claude loads it in every project. `project`: added to this project only. */
export const McpSchema = z.object({ name: z.string(), enabled: z.boolean(), scope: z.enum(["user", "project"]) });
export type Mcp = z.infer<typeof McpSchema>;

/** The MCP servers Claude loads in each folder, keyed by the folder asked for. */
export const listMcps = defineRpc({
  name: "mcp-toggle.list",
  input: z.object({ cwds: z.array(z.string().min(1)).max(500) }),
  output: z.record(z.string(), z.array(McpSchema)),
});

export const listProjects = defineRpc({
  name: "mcp-toggle.projects",
  input: z.object({}),
  output: z.array(z.object({ name: z.string(), path: z.string() })),
});

/** With `agentId`, that agent's session is reloaded to pick up the change, and resumed if it was running. */
export const setMcp = defineRpc({
  name: "mcp-toggle.set",
  input: z.object({
    cwd: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    agentId: z.string().optional(),
  }),
  output: z.object({ reloadError: z.string().nullable() }),
});
