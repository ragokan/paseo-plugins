import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LiveAgent {
  status: string;
  archived: boolean;
}

/** The daemon calls the resume makes. They go through the `paseo` CLI: a plugin gets no Paseo client at startup. */
export interface PaseoCli {
  /** Resolves once the daemon answers, which can take a moment while it boots. */
  ready(signal: AbortSignal): Promise<void>;
  /** Null when the agent no longer exists. */
  inspect(agentId: string, signal: AbortSignal): Promise<LiveAgent | null>;
  send(agentId: string, message: string, signal: AbortSignal): Promise<void>;
}

const READY_TIMEOUT_MS = 120_000;

// The daemon runs this plugin from its own install, .../@getpaseo/cli/node_modules/@getpaseo/server/...,
// whose CLI serves when `paseo` is not on the daemon's PATH.
function bundledCli(): string | null {
  const script = process.argv[1] ?? "";
  const marker = `${path.sep}@getpaseo${path.sep}cli${path.sep}`;
  const at = script.indexOf(marker);
  if (at === -1) return null;
  const cli = path.join(script.slice(0, at + marker.length), "bin", "paseo");
  return existsSync(cli) ? cli : null;
}

async function paseo(args: string[], signal: AbortSignal): Promise<string> {
  // PASEO_HOME is the daemon's own home, so the CLI reaches this daemon and no other.
  const home = process.env.PASEO_HOME ? ["--home", process.env.PASEO_HOME] : [];
  const options = { signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
  try {
    return (await execFileAsync("paseo", [...args, ...home], options)).stdout;
  } catch (error) {
    const cli = bundledCli();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !cli) throw error;
    return (await execFileAsync(process.execPath, [cli, ...args, ...home], options)).stdout;
  }
}

function errorCode(error: unknown): string | null {
  try {
    return JSON.parse((error as { stdout?: string }).stdout ?? "").error?.code ?? null;
  } catch {
    return null;
  }
}

export const paseoCli: PaseoCli = {
  async ready(signal) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        await paseo(["ls", "-q"], signal);
        return;
      } catch (error) {
        if (signal.aborted || Date.now() > deadline) throw error;
        await sleep(2000, undefined, { signal });
      }
    }
  },

  async inspect(agentId, signal) {
    let stdout: string;
    try {
      stdout = await paseo(["inspect", agentId, "--json"], signal);
    } catch (error) {
      if (errorCode(error) === "AGENT_NOT_FOUND") return null;
      throw error;
    }
    const agent = JSON.parse(stdout) as { Status?: unknown; Archived?: unknown };
    return { status: String(agent.Status), archived: agent.Archived === true };
  },

  async send(agentId, message, signal) {
    await paseo(["send", agentId, "--no-wait", "--prompt", message], signal);
  },
};
