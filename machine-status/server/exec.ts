import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Dates and numbers in the C locale's words, whatever language the daemon runs in.
const C_LOCALE = { ...process.env, LC_ALL: "C" };

/**
 * Runs a binary directly, never through a shell. Paths and PIDs flow into these
 * calls, and argv-style invocation removes any chance of shell interpretation.
 */
export async function run(file: string, args: string[], timeoutMs = 5_000): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    env: C_LOCALE,
  });
  return stdout;
}

/** Same as `run`, but a missing binary or non-zero exit resolves to null instead of throwing. */
export async function tryRun(file: string, args: string[], timeoutMs = 5_000): Promise<string | null> {
  try {
    return await run(file, args, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Returns stdout even when the command exits non-zero: lsof exits 1 when one of
 * the PIDs it was asked about has gone, and still lists the others.
 */
export async function runTolerant(file: string, args: string[], timeoutMs = 5_000): Promise<string> {
  try {
    return await run(file, args, timeoutMs);
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

const binaries = new Map<string, string>();

/**
 * A system binary by absolute path, looked up once. The daemon may run under
 * systemd or launchd-like supervisors with a minimal PATH.
 */
export function binary(name: string): string {
  let found = binaries.get(name);
  if (found === undefined) {
    found =
      ["/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/local/bin", "/snap/bin"]
        .map((dir) => `${dir}/${name}`)
        .find((file) => existsSync(file)) ?? name;
    binaries.set(name, found);
  }
  return found;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Returns both streams. `docker logs` writes container stdout and stderr to the
 * matching stream of its own process, so reading only stdout loses the output of
 * every container that logs to stderr — which most of them do.
 */
export async function runStreams(
  file: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout, stderr };
}
