import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Family, Usage } from "../shared/model";
import { sharedUsage } from "../shared/rpc";
import { paseoHome } from "./paths";

/** ZeroSub's install ID, the same on every host. */
const PLUGIN_ID = "zerosub";
/** How long one host's readings are reused, so a round of polls asks each host once. */
const READINGS_MS = 20_000;
/** A host that takes longer than this to answer is skipped this round. */
const HOST_MS = 5_000;

export type SharedReading = { family: Family; identity: string; usage: Usage };

/** What sharing needs from Paseo's connected hosts. */
export interface Hosts {
  /** This daemon's own names: its hostname and server ID. */
  self(): Promise<string[]>;
  list(): Promise<Array<{ serverId: string; label: string | null; online: boolean }>>;
  /** That host's answer to `sharedUsage`. */
  readings(serverId: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Usage readings other hosts' ZeroSub already took, asked in the order set in preferences, so the
 * hosts share one read of each account instead of each asking the provider. Only hosts before this
 * one in the order are asked. A host that is offline, unreachable or slow is skipped, and nothing
 * here throws: without an answer, this host reads the account itself.
 */
export class Peers {
  private order: string[] = [];
  private readonly cache = new Map<string, { at: number; readings: Promise<SharedReading[]> }>();
  private readonly answering = new Map<string, boolean>();

  constructor(private readonly hosts: Hosts = daemonHosts()) {}

  setOrder(names: readonly string[]): void {
    this.order = names.map((name) => name.trim().toLowerCase()).filter(Boolean);
  }

  /** The first reading of this account taken after `after`, from the hosts ahead of this one. */
  async reading(family: Family, identity: string, after: number): Promise<Usage | null> {
    if (this.order.length === 0) return null;
    try {
      for (const host of await this.ahead()) {
        const match = (await this.readingsOf(host)).find((reading) => reading.family === family && reading.identity === identity);
        if (match && Date.parse(match.usage.fetchedAt) > after) return match.usage;
      }
    } catch (error) {
      this.note("this host's daemon", false, error);
    }
    return null;
  }

  stop(): Promise<void> {
    return this.hosts.close().catch(() => undefined);
  }

  /** The online hosts listed before this one, matched by host name or server ID. */
  private async ahead(): Promise<Array<{ serverId: string; name: string }>> {
    const self = (await this.hosts.self()).map((name) => name.toLowerCase());
    const position = this.order.findIndex((name) => self.includes(name));
    const before = position < 0 ? this.order : this.order.slice(0, position);
    if (before.length === 0) return [];
    const hosts = await this.hosts.list();
    return before.flatMap((name) => {
      const host = hosts.find((entry) => entry.serverId.toLowerCase() === name || entry.label?.toLowerCase() === name);
      return host?.online ? [{ serverId: host.serverId, name }] : [];
    });
  }

  private readingsOf(host: { serverId: string; name: string }): Promise<SharedReading[]> {
    const cached = this.cache.get(host.serverId);
    if (cached && Date.now() - cached.at < READINGS_MS) return cached.readings;
    const readings = withDeadline(this.hosts.readings(host.serverId), HOST_MS)
      .then((output) => sharedUsage.output.parse(output).readings)
      .then(
        (readings) => {
          this.note(host.name, true);
          return readings;
        },
        (error: unknown) => {
          this.note(host.name, false, error);
          return [];
        },
      );
    this.cache.set(host.serverId, { at: Date.now(), readings });
    return readings;
  }

  /** Logs when a host stops or starts answering, once each time, so an offline host doesn't fill the log. */
  private note(host: string, ok: boolean, error?: unknown): void {
    if ((this.answering.get(host) ?? true) === ok) return;
    this.answering.set(host, ok);
    const reason = error instanceof Error ? error.message : String(error);
    console.log(ok ? `[ZeroSub] usage readings from ${host} again` : `[ZeroSub] no usage readings from ${host}, reading without it: ${reason}`);
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// The parts of @getpaseo/client this uses. Its types are not imported: a Git install has no
// node_modules, and Paseo will not build a plugin whose type imports it cannot resolve.
interface Daemon {
  connect(): Promise<void>;
  close(): Promise<void>;
  getLastServerInfoMessage(): { serverId?: string; hostname?: string | null } | null;
  listHosts(): Promise<{ hosts: Array<{ serverId: string; label?: string | null; enabled: boolean; status: string }> }>;
  openHostRoute(serverId: string, scopeId: string): Promise<string>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}
interface ClientModules {
  DaemonClient: new (config: Record<string, unknown>) => Daemon;
  createHostChannelTransport(origin: Daemon, serverId: string, scopeId: string, routeId: string): unknown;
}

// shortcut: the plugin SDK can't call plugin RPCs on another host (`paseo.hosts.client` has no
// plugin calls), so this connects to its own daemon as the CLI does, with the local credential,
// and reaches other hosts through that daemon's host routes, as Paseo's fleet tools do. The modules
// come from the daemon's own @getpaseo/client: esbuild leaves a require it cannot resolve for
// runtime, and Paseo hands modules it does not supply to the daemon's own require.
function clientModules(): ClientModules {
  const hostRequire: (id: string) => unknown = require;
  const { DaemonClient } = hostRequire("@getpaseo/client/internal/daemon-client") as Pick<ClientModules, "DaemonClient">;
  const { createHostChannelTransport } = hostRequire("@getpaseo/client/internal/hosts") as Pick<ClientModules, "createHostChannelTransport">;
  return { DaemonClient, createHostChannelTransport };
}

/** The local daemon's WebSocket URL, from its config; a daemon listening on every address is reached on loopback. */
export function daemonUrl(home: string): string {
  let listen = "127.0.0.1:6767";
  try {
    listen = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).daemon?.listen ?? listen;
  } catch {
    // No config: the daemon's default.
  }
  const match = /^(?:\[([^\]]+)\]|([\w.-]+)):(\d+)$/.exec(listen);
  if (!match) throw new Error(`the daemon listens on ${listen}, not a TCP address`);
  const host = match[1] ?? match[2]!;
  const loopback = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : match[1] ? `[${host}]` : host;
  return `ws://${loopback}:${match[3]}/ws`;
}

/** Other hosts, through this host's daemon. Connects on first use, and again after a failed connect. */
function daemonHosts(): Hosts {
  let local: Promise<Daemon> | null = null;
  const connect = (): Promise<Daemon> => {
    if (local) return local;
    const pending = (async () => {
      const home = paseoHome();
      const daemon = new (clientModules().DaemonClient)({
        url: daemonUrl(home),
        clientId: "zerosub-usage",
        clientType: "cli",
        localCredential: () => {
          try {
            return readFileSync(join(home, "local-credential"), "utf8").trim() || undefined;
          } catch {
            return undefined;
          }
        },
        reconnect: { enabled: true },
      });
      try {
        await daemon.connect();
      } catch (error) {
        await daemon.close().catch(() => undefined);
        throw error;
      }
      return daemon;
    })();
    local = pending;
    pending.catch(() => {
      if (local === pending) local = null;
    });
    return pending;
  };
  return {
    async self() {
      const info = (await connect()).getLastServerInfoMessage();
      return [info?.hostname, info?.serverId].filter((name): name is string => Boolean(name));
    },
    async list() {
      const { hosts } = await (await connect()).listHosts();
      return hosts.map((host) => ({ serverId: host.serverId, label: host.label ?? null, online: host.enabled && host.status === "online" }));
    },
    async readings(serverId) {
      const origin = await connect();
      const { DaemonClient, createHostChannelTransport } = clientModules();
      const scopeId = randomUUID();
      const routeId = await origin.openHostRoute(serverId, scopeId);
      const remote = new DaemonClient({
        url: "ws://routed-host/ws",
        clientId: scopeId,
        transportFactory: createHostChannelTransport(origin, serverId, scopeId, routeId),
        reconnect: { enabled: false },
      });
      try {
        await remote.connect();
        return await remote.invokePluginRpc(PLUGIN_ID, sharedUsage.name, {});
      } finally {
        await remote.close().catch(() => undefined);
      }
    },
    async close() {
      const pending = local;
      local = null;
      await (await pending?.catch(() => null))?.close().catch(() => undefined);
    },
  };
}
