import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The sidebar's hidden workspaces, by name, in this host's settings: the iOS and Android apps give
 * plugins no storage of their own, but they can read a host's. Every app saves to every host it
 * reaches and hides a name any of them lists. done lists this host's workspaces marked as done in
 * Idle by hand, by id, with when they entered Done.
 */
export const workspaceSettings = defineSettings({
  id: "workspaces",
  scope: "host",
  version: 1,
  schema: z.object({
    hidden: z.array(z.string()).default([]),
    done: z.record(z.string(), z.number()).default({}),
  }),
});
export type WorkspaceValues = z.output<typeof workspaceSettings.schema>;
