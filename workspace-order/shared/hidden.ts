import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The workspaces hidden from the sidebar, by name, in this host's settings: the iOS and Android
 * apps give plugins no storage of their own, but they can read a host's. The app hides a name that
 * any host it reaches lists.
 */
export const hiddenWorkspacesSettings = defineSettings({
  id: "hidden-workspaces",
  scope: "host",
  version: 1,
  schema: z.object({ names: z.array(z.string()).default([]) }),
});
