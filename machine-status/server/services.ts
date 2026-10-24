import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import { binary, describeError, run, tryRun } from "./exec.ts";
import { cwdsOf, commandOf, readProcTable, type RawProcess } from "./proc.ts";
import { readMacListeners } from "./mac.ts";
import { ancestorsOf } from "./processes.ts";
import {
  classifyRelevance,
  friendlyName,
  httpUrlFor,
  normalizeAgents,
  parseSocketAddress,
  portKey,
  scopeOf,
} from "../shared/services-classify.ts";
import type { PortRow, ServiceRow, readServices } from "../shared/services.ts";

type Output = z.output<typeof readServices.output>;

/* -------------------------------------------------------------------------- */
/* Parsers                                                                      */
/* -------------------------------------------------------------------------- */

export interface Listener {
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  /** The first process holding the socket; null when it belongs to another user. */
  pid: number | null;
  command: string | null;
}

/**
 * Reads `ss -H -tulnp`. ss lists every listener on the machine, including other
 * users', but only names the processes this user may inspect, so a root-owned
 * port is reported as unattributable rather than omitted. Forked workers share
 * one socket and appear together in `users:(…)`; the first is the owner.
 */
export function parseSsListeners(raw: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of raw.split("\n")) {
    const match = /^(tcp|udp)\s+\S+\s+\d+\s+\d+\s+(\S+)\s+\S+\s*(.*)$/.exec(line);
    if (!match) continue;
    const parsed = parseSocketAddress(match[2]);
    if (!parsed) continue;
    const owner = /\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(match[3]);
    listeners.push({
      protocol: match[1] as "tcp" | "udp",
      ...parsed,
      pid: owner ? Number(owner[2]) : null,
      command: owner ? owner[1] : null,
    });
  }
  return listeners;
}

export interface DockerContainer {
  name: string;
  image: string;
  ports: number[];
}

export function parseDockerPs(raw: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of raw.split("\n")) {
    const [name, image, ports] = line.split("\t");
    if (!name || !image) continue;
    const published = new Set<number>();
    // "0.0.0.0:5653->5432/tcp, [::]:5653->5432/tcp" — only the published side matters.
    for (const match of (ports ?? "").matchAll(/:(\d+)->/g)) published.add(Number(match[1]));
    containers.push({ name, image, ports: [...published].sort((a, b) => a - b) });
  }
  return containers;
}

/* -------------------------------------------------------------------------- */
/* Process-tree attribution                                                     */
/* -------------------------------------------------------------------------- */

/** Every process below `pid`, excluding `pid` itself. */
export function descendantsOf(pid: number, table: readonly RawProcess[]): RawProcess[] {
  const children = new Map<number, RawProcess[]>();
  for (const entry of table) {
    const bucket = children.get(entry.ppid);
    if (bucket) bucket.push(entry);
    else children.set(entry.ppid, [entry]);
  }

  const found: RawProcess[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/**
 * A provider name must match the binary as a whole word, not as a prefix, or
 * unrelated binaries such as `ampd` or `cursorsvc` would be reported as the
 * "amp" and "cursor" agents.
 */
export function binaryMatchesProvider(binary: string, provider: string): boolean {
  if (provider.length === 0) return false;
  if (binary === provider) return true;
  if (!binary.startsWith(provider)) return false;
  return /^[^a-z0-9]/.test(binary.slice(provider.length));
}

export interface AgentRoot {
  pid: number;
  provider: string;
  title: string;
  cwd: string;
  command: string;
}

/**
 * Identifies which daemon children are coding agents.
 *
 * Matching on the command name alone does not work: a substring search for
 * "amp" or "cursor" hits unrelated binaries. The reliable signal is structural — Paseo starts each agent as its own child — and
 * it is confirmed against the daemon's own agent list, so anything else under the
 * daemon (esbuild, Paseo's internal helpers, this plugin) is left out.
 */
export function matchAgentRoots(
  daemonChildren: readonly (RawProcess & { command: string; cwd: string })[],
  agents: readonly { id: string; provider: string; cwd: string; title: string }[],
  excluded: ReadonlySet<number>,
): AgentRoot[] {
  const roots: AgentRoot[] = [];
  const claimed = new Set<string>();

  for (const child of daemonChildren) {
    if (excluded.has(child.pid)) continue;
    const binary = (child.command.split("/").pop() ?? "").toLowerCase();
    const sameProvider = agents.filter(
      (candidate) => candidate.provider.length > 0 && binaryMatchesProvider(binary, candidate.provider),
    );
    if (sameProvider.length === 0) continue;

    // cwd disambiguates two agents of the same provider in different workspaces
    const agent = sameProvider.find(
      (candidate) =>
        !claimed.has(candidate.id) && (candidate.cwd === "" || child.cwd === "" || candidate.cwd === child.cwd),
    );
    if (agent) {
      claimed.add(agent.id);
      roots.push({
        pid: child.pid,
        provider: agent.provider,
        title: agent.title,
        cwd: child.cwd || agent.cwd,
        command: child.command,
      });
      continue;
    }

    // Paseo starts Codex's app-server in the daemon's directory, not the agent's,
    // so the cwd cannot say which agent it is. It is still that provider's agent;
    // which one stays unknown rather than guessed.
    roots.push({ pid: child.pid, provider: sameProvider[0].provider, title: "", cwd: "", command: child.command });
  }
  return roots;
}

const SCOPE_WIDTH = { public: 3, lan: 2, local: 1 } as const;

/**
 * One process bound to one port on both IPv4 and IPv6 is one service, and
 * `kubectl port-forward` produces exactly that. Rows are collapsed per process,
 * keeping the widest bind, because that is the one that decides reachability.
 * Sockets with no visible owner stay separate: without a PID there is no evidence
 * they are the same thing.
 */
export function collapseDuplicateBinds<T extends { protocol: string; port: number; pid: number | null; address: string; scope: "public" | "lan" | "local" }>(
  rows: readonly T[],
): T[] {
  const widest = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.protocol}:${row.port}:${row.pid ?? `@${row.address}`}`;
    const current = widest.get(key);
    if (!current) {
      widest.set(key, row);
      continue;
    }
    const better =
      SCOPE_WIDTH[row.scope] > SCOPE_WIDTH[current.scope] ||
      (SCOPE_WIDTH[row.scope] === SCOPE_WIDTH[current.scope] &&
        !row.address.includes(":") &&
        current.address.includes(":"));
    if (better) widest.set(key, row);
  }
  return [...widest.values()];
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                   */
/* -------------------------------------------------------------------------- */

export async function readServicesHandler(
  _input: unknown,
  context: PluginHandlerContext,
): Promise<Output> {
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") {
    throw new Error(`machine-status inspects ports on Linux and macOS; this daemon runs on ${process.platform}.`);
  }

  const notes: string[] = [];

  const [{ listeners, othersHidden }, dockerRaw, agentList] = await Promise.all([
    // macOS has no ss: lsof names this user's sockets, netstat lists everyone's.
    mac
      ? readMacListeners()
      : run(binary("ss"), ["-H", "-tulnp"], 8_000).then((raw) => ({ listeners: parseSsListeners(raw), othersHidden: false })),
    tryRun(binary("docker"), ["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}"], 4_000),
    context.paseo.agents.list().then(
      (list) => normalizeAgents(list),
      (error: unknown) => {
        notes.push(`Agent list unavailable, so ports are not attributed to agents: ${describeError(error)}`);
        return [] as ReturnType<typeof normalizeAgents>;
      },
    ),
  ]);

  const table = await readProcTable();
  const home = os.homedir();
  // ss and lsof name a process by its short name; the command line has the
  // full path, and the path is what separates /usr/sbin/... from ~/.venv/bin/python.
  const commands = new Map<number, string>();
  const commandFor = (pid: number): string => {
    let command = commands.get(pid);
    if (command === undefined) {
      command = commandOf(pid, table.find((entry) => entry.pid === pid)?.comm ?? "");
      commands.set(pid, command);
    }
    return command;
  };

  // --- agent roots -----------------------------------------------------------
  const daemonPid = process.ppid;
  const ownChain = ancestorsOf(process.pid, table);
  const daemonChildren = table.filter((entry) => entry.ppid === daemonPid);
  const cwds = await cwdsOf(daemonChildren.map((child) => child.pid));
  const children = daemonChildren.map((child) => ({ ...child, command: commandFor(child.pid), cwd: cwds.get(child.pid) ?? "" }));
  const roots = matchAgentRoots(children, agentList, ownChain);

  /** pid -> the agent it ultimately belongs to. */
  const ownerByPid = new Map<number, AgentRoot>();
  const childrenByRoot = new Map<number, RawProcess[]>();
  for (const root of roots) {
    ownerByPid.set(root.pid, root);
    const descendants = descendantsOf(root.pid, table);
    childrenByRoot.set(root.pid, descendants);
    for (const descendant of descendants) ownerByPid.set(descendant.pid, root);
  }

  const containers = parseDockerPs(dockerRaw ?? "");
  const dockerByPort = new Map<number, DockerContainer>();
  for (const container of containers) {
    for (const port of container.ports) dockerByPort.set(port, container);
  }

  // --- ports -----------------------------------------------------------------
  const seen = new Set<string>();
  const ports: PortRow[] = [];
  let hidden = 0;

  for (const listener of listeners) {
    const key = portKey(listener.protocol, listener.address, listener.port);
    if (seen.has(key)) continue;
    seen.add(key);

    const scope = scopeOf(listener.address);
    const pid = listener.pid;
    const owner = pid !== null ? ("you" as const) : ("other" as const);
    if (pid === null) hidden += 1;
    const command = pid !== null ? commandFor(pid) : null;

    const agent = pid !== null ? ownerByPid.get(pid) : undefined;
    const container = dockerByPort.get(listener.port);

    const attribution = agent
      ? {
          kind: (agent.pid === pid ? "agent" : "agent-child") as "agent" | "agent-child",
          label: agent.title || agent.provider,
          detail:
            agent.pid === pid
              ? `${agent.provider} agent`
              : agent.cwd
                ? `started by the ${agent.provider} agent in ${path.basename(agent.cwd) || agent.cwd}`
                : `started by a ${agent.provider} agent`,
        }
      : container
        ? { kind: "docker" as const, label: container.name, detail: container.image }
        : command !== null
          ? { kind: "process" as const, label: friendlyName(command), detail: command }
          : null;

    ports.push({
      id: key,
      port: listener.port,
      protocol: listener.protocol,
      address: listener.address,
      scope,
      pid,
      command,
      owner,
      relevance: classifyRelevance({
        kind: attribution?.kind ?? null,
        command: command ?? "",
        owner,
        home,
      }),
      attribution,
      url: httpUrlFor({ protocol: listener.protocol, scope, port: listener.port }),
    });
  }
  const collapsed = collapseDuplicateBinds(ports).sort((left, right) => left.port - right.port);

  if (hidden > 0) {
    notes.push(
      `${hidden} listening socket${hidden === 1 ? "" : "s"} belong to another user; run with elevated rights to attribute them.`,
    );
  }
  if (othersHidden) notes.push("macOS showed this plugin only your own processes' sockets, so other users' ports are not listed.");
  if (dockerRaw === null) notes.push("Docker was not reachable, so containers are not listed.");

  // --- services --------------------------------------------------------------
  const portsByPid = new Map<number, number[]>();
  for (const row of collapsed) {
    if (row.pid === null) continue;
    portsByPid.set(row.pid, [...(portsByPid.get(row.pid) ?? []), row.port]);
  }

  const services: ServiceRow[] = [];
  for (const root of roots) {
    services.push({
      id: `agent-${root.pid}`,
      name: root.title || `${root.provider} agent`,
      subtitle: root.cwd ? `${root.provider} · ${path.basename(root.cwd) || root.cwd}` : `PID ${root.pid}`,
      ports: portsByPid.get(root.pid) ?? [],
      status: "running",
      source: "agent",
      relevance: "dev",
      pid: root.pid,
    });
    for (const child of childrenByRoot.get(root.pid) ?? []) {
      services.push({
        id: `agent-child-${child.pid}`,
        name: friendlyName(commandFor(child.pid)),
        subtitle: `background process of the ${root.provider} agent`,
        ports: portsByPid.get(child.pid) ?? [],
        status: "running",
        source: "agent-child",
        relevance: "dev",
        pid: child.pid,
      });
    }
  }
  for (const container of containers) {
    services.push({
      id: `docker-${container.name}`,
      name: container.name,
      subtitle: container.image,
      ports: container.ports,
      status: "running",
      source: "docker",
      relevance: "dev",
      pid: null,
    });
  }
  for (const [pid, list] of portsByPid) {
    if (ownerByPid.has(pid)) continue;
    const command = commandFor(pid);
    services.push({
      id: `listener-${pid}`,
      name: friendlyName(command),
      subtitle: `PID ${pid}`,
      ports: [...new Set(list)].sort((a, b) => a - b),
      status: "running",
      source: "listener",
      relevance: classifyRelevance({ kind: "process", command, owner: "you", home }),
      pid,
    });
  }

  return { collectedAt: new Date().toISOString(), ports: collapsed, services, notes };
}
