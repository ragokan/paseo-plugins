import { readFileSync } from "node:fs";
import path from "node:path";
import type { LabelColor } from "./labels.ts";

// The parts of @getpaseo/client this plugin uses. Its types are not imported: a Git install has no
// node_modules, and Paseo will not build a plugin whose type imports it cannot resolve.
export interface Snapshot<Entry> {
  entries: Entry[];
}
export interface Subscription<Entry> {
  subscribe(observer: {
    snapshot(snapshot: Snapshot<Entry>): void;
    update(message: { type: string; payload: { kind: string } & Record<string, unknown> }): void;
    error?(error: unknown): void;
  }): () => void;
  release(): Promise<void>;
}
export interface WorkspaceSnapshot {
  id: string;
  status: string;
  statusEnteredAt?: string | null;
  labels?: string[];
}
export interface AgentSnapshot {
  id: string;
  workspaceId?: string | null;
  status: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
}
type Listing<Entry> = Promise<Snapshot<Entry> & { subscription: Subscription<Entry> }>;
export interface Api {
  workspaces: { list(options: { includeBackground: true; page: { limit: number }; subscribe: {} }): Listing<WorkspaceSnapshot> };
  agents: {
    list(options: { scope: "active"; includeBackground: true; page: { limit: number }; subscribe: {} }): Listing<{ agent: AgentSnapshot }>;
  };
  hosts: {
    list(): Promise<{ hosts: Array<{ serverId: string; enabled: boolean; status: string }> }>;
    client(serverId: string): Promise<Api>;
  };
}
export interface Daemon {
  connect(): Promise<void>;
  close(): Promise<void>;
  setWorkspaceLabel(options: {
    workspaceId: string;
    label: { name: string; color: LabelColor };
    assigned: boolean;
  }): Promise<{ workspaceLabels: string[] }>;
}

interface ClientModules {
  DaemonClient: new (config: Record<string, unknown>) => Daemon;
  createPaseoApi(daemon: Daemon): Api;
}

// shortcut: the plugin SDK has no workspace label calls yet, so this opens a second connection to the
// daemon, as the CLI does, with its local credential. It uses the daemon's own @getpaseo/client, so it
// always speaks the daemon's protocol: esbuild leaves a require it cannot read for runtime, where Paseo
// hands modules it does not supply to the daemon's own require. Switch to SDK calls once they exist.
function hostClient(): ClientModules {
  const hostRequire: (id: string) => unknown = require;
  const { DaemonClient } = hostRequire("@getpaseo/client/internal/daemon-client") as Pick<ClientModules, "DaemonClient">;
  const { createPaseoApi } = hostRequire("@getpaseo/client") as Pick<ClientModules, "createPaseoApi">;
  return { DaemonClient, createPaseoApi };
}

/** The local daemon's WebSocket URL, from its config; a daemon listening on every address is reached on loopback. */
export function daemonUrl(home: string): string {
  let listen = "127.0.0.1:6767";
  try {
    listen = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).daemon?.listen ?? listen;
  } catch {
    // No config: the daemon's default.
  }
  const match = /^(?:\[([^\]]+)\]|([\w.-]+)):(\d+)$/.exec(listen);
  if (!match) throw new Error(`the daemon listens on ${listen}, not a TCP address`);
  const host = match[1] ?? match[2]!;
  const loopback = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : match[1] ? `[${host}]` : host;
  return `ws://${loopback}:${match[3]}/ws`;
}

/** Opens a connection to the daemon this plugin runs in. It reconnects by itself after the first. */
export async function connectDaemon(): Promise<{ daemon: Daemon; paseo: Api }> {
  const home = process.env.PASEO_HOME;
  if (!home) throw new Error("PASEO_HOME is not set");
  const { DaemonClient, createPaseoApi } = hostClient();
  const daemon = new DaemonClient({
    url: daemonUrl(home),
    clientId: "ragokan-status-labels",
    clientType: "cli",
    localCredential: () => {
      try {
        return readFileSync(path.join(home, "local-credential"), "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    },
    reconnect: { enabled: true },
  });
  try {
    await daemon.connect();
  } catch (error) {
    await daemon.close().catch(() => {});
    throw error;
  }
  return { daemon, paseo: createPaseoApi(daemon) };
}
