import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The sidebar's order and hidden workspaces, by name, in this host's settings: the iOS and Android
 * apps give plugins no storage of their own, but they can read a host's. Every app saves to every
 * host it reaches, hides a name any of them lists and follows the order saved last. done lists this
 * host's workspaces moved from Stale to Done by hand, by id, with when they entered Done.
 */
export const workspaceSettings = defineSettings({
  id: "workspaces",
  scope: "host",
  version: 1,
  schema: z.object({
    hidden: z.array(z.string()).default([]),
    order: z.array(z.string()).default([]),
    orderSavedAt: z.number().default(0),
    done: z.record(z.string(), z.number()).default({}),
  }),
});
export type WorkspaceValues = z.output<typeof workspaceSettings.schema>;
