import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/** Renames the agent. The plugin SDK can retitle a workspace but not an agent, so this goes through the `paseo` CLI. */
export async function renameAgent(agentId: string, title: string, signal: AbortSignal): Promise<void> {
  await paseo(["agent", "update", agentId, `--name=${title}`], signal);
}
