import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { Mcp } from "../shared/rpc";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

interface LayerName {
  type: string;
  profile?: string | null;
}

/** The parts of Codex app-server's `config/read` reply this plugin uses. Layers come highest precedence first. */
export interface CodexConfig {
  config: { mcp_servers?: Record<string, { enabled?: boolean }> | null };
  origins: Record<string, { name: LayerName } | undefined>;
  layers: { name: LayerName; config: unknown }[] | null;
}

const PROJECT_FILE = "this project's .codex/config.toml";

/**
 * Codex keeps one `enabled` per server, so a switch here applies to every project. The plugin only
 * edits ~/.codex/config.toml, so a server a project's own .codex/config.toml defines or switches is locked.
 */
export function codexMcpsFrom({ config, origins, layers }: CodexConfig): Mcp[] {
  const servers = config.mcp_servers ?? {};
  return Object.keys(servers)
    .sort()
    .map((name) => {
      const definedIn = (layers ?? [])
        .filter((layer) => isObject(layer.config) && isObject(layer.config.mcp_servers) && name in layer.config.mcp_servers)
        .map((layer) => layer.name.type);
      const scope = definedIn.length > 0 && definedIn.every((type) => type === "project") ? "project" : "user";
      const switchedIn = origins[`mcp_servers.${name}.enabled`]?.name;
      let locked: string | undefined;
      if (scope === "project") locked = `Added in ${PROJECT_FILE}`;
      else if (switchedIn?.type === "project") locked = `Switched in ${PROJECT_FILE}`;
      else if (switchedIn?.type === "user" && switchedIn.profile) locked = `Switched in Codex profile "${switchedIn.profile}"`;
      else if (switchedIn && switchedIn.type !== "user") locked = `Switched in Codex's ${switchedIn.type} config`;
      const mcp: Mcp = { name, enabled: servers[name]?.enabled !== false, scope };
      return locked ? { ...mcp, locked } : mcp;
    });
}

export async function listCodexMcpsFor(cwds: readonly string[]): Promise<Record<string, Mcp[]>> {
  return withAppServer(async (request) => {
    const result: Record<string, Mcp[]> = {};
    for (const cwd of cwds) result[cwd] = codexMcpsFrom((await request("config/read", { includeLayers: true, cwd })) as CodexConfig);
    return result;
  });
}

export async function setCodexMcpEnabled(cwd: string, name: string, enabled: boolean): Promise<void> {
  await withAppServer(async (request) => {
    const read = (await request("config/read", { includeLayers: true, cwd })) as CodexConfig;
    const server = codexMcpsFrom(read).find((entry) => entry.name === name);
    if (!server) throw new Error(`Codex has no MCP server named "${name}" for ${cwd}`);
    if (server.locked) throw new Error(`Codex's "${name}" cannot be switched here: ${server.locked}`);
    // The key path is dot-separated; Codex's own `codex mcp add` allows only these characters.
    if (!/^[\w-]+$/.test(name)) throw new Error(`Codex's "${name}" has a name this plugin cannot edit`);
    // Codex edits config.toml in place, keeping its comments and layout.
    await request("config/value/write", { keyPath: `mcp_servers.${name}.enabled`, value: enabled, mergeStrategy: "upsert" });
  });
}

type Request = (method: string, params: unknown) => Promise<unknown>;

/** Runs `use` against a short-lived `codex app-server`, which reads every Codex config layer and writes ~/.codex/config.toml. */
async function withAppServer<T>(use: (request: Request) => Promise<T>): Promise<T> {
  const child = spawnProcess(await findCodex(), ["app-server"], { stdio: "pipe", env: process.env });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let failure: Error | null = null;
  let stderr = "";
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-1_000)));
  child.on("exit", (code) => fail(new Error(`codex app-server exited with ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    // Notifications and Codex's own requests to the client carry a method; replies do not.
    const waiter = typeof message.id === "number" && !("method" in message) ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id as number);
    if (isObject(message.error)) waiter.reject(new Error(String(message.error.message ?? "Codex config request failed")));
    else waiter.resolve(message.result);
  });
  let lastId = 0;
  const send = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request: Request = (method, params) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      pending.set(++lastId, { resolve, reject });
      send({ id: lastId, method, params });
    });
  // Paseo fails a plugin request after 30s, and a toggle still has to reload the agent after this.
  const timer = setTimeout(() => fail(new Error("codex app-server did not answer within 10s")), 10_000);
  try {
    await request("initialize", { clientInfo: { name: "mcp-toggle", title: "MCP toggle", version: "0.0.0" }, capabilities: null });
    send({ method: "initialized" });
    return await use(request);
  } finally {
    clearTimeout(timer);
    await terminateProcess(child).catch(() => undefined);
  }
}

/** Paseo starts Codex from the daemon's PATH; the usual install folders cover a plugin process with a shorter one. */
async function findCodex(): Promise<string> {
  // shortcut: macOS and Linux only, and ignores a codex command set in Paseo's provider settings.
  const folders = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const folder of folders) {
    const candidate = join(folder, "codex");
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  throw new Error("The codex command-line tool was not found on this machine.");
}
