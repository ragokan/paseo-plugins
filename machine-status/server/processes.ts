import { readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { killProcess, listProcesses, ProcessSchema } from "../shared/contracts.ts";
import { describeError } from "./exec.ts";
import { commandOf, readProcTable, sampleProcesses, type RawProcess } from "./proc.ts";

type ProcessEntry = z.output<typeof ProcessSchema>;
type ListInput = z.output<typeof listProcesses.input>;
type ListOutput = z.output<typeof listProcesses.output>;
type KillInput = z.output<typeof killProcess.input>;
type KillOutput = z.output<typeof killProcess.output>;

/**
 * Walks the parent chain from `pid` upwards, including `pid` itself. The visited
 * set doubles as cycle protection: a reparented process can otherwise produce a
 * loop in a snapshot taken while the table was changing.
 */
export function ancestorsOf(pid: number, table: readonly Pick<RawProcess, "pid" | "ppid">[]): Set<number> {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const chain = new Set<number>();
  let current = byPid.get(pid);
  while (current && !chain.has(current.pid)) {
    chain.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return chain;
}

/**
 * PIDs this plugin must never signal. The plugin runs as a child of the Paseo
 * daemon, so its own ancestor chain is exactly the set of processes whose death
 * would take Paseo — and this plugin — down with it.
 */
export function guardedPids(table: readonly Pick<RawProcess, "pid" | "ppid">[], selfPid: number): Set<number> {
  const guarded = ancestorsOf(selfPid, table);
  guarded.add(0);
  guarded.add(1);
  return guarded;
}

export function processName(command: string): string {
  const base = path.basename(command);
  return base.length > 0 ? base : command;
}

export function sortByUsage<T extends { pid: number; rssBytes: number }>(
  table: readonly T[],
  cpu: ReadonlyMap<number, number>,
  sortBy: "cpu" | "memory",
): T[] {
  return [...table].sort((left, right) =>
    sortBy === "cpu"
      ? (cpu.get(right.pid) ?? 0) - (cpu.get(left.pid) ?? 0) || right.rssBytes - left.rssBytes
      : right.rssBytes - left.rssBytes,
  );
}

/** A zombie has already exited and only waits for its parent to collect it. */
function isAlive(pid: number): boolean {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    return raw.slice(raw.lastIndexOf(")") + 2, raw.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function listProcessesHandler({ sortBy, limit }: ListInput): Promise<ListOutput> {
  const { table, cpu } = await sampleProcesses();
  const guarded = guardedPids(table, process.pid);
  // Only the rows that are shown pay for reading their command line.
  const items: ProcessEntry[] = sortByUsage(table, cpu, sortBy)
    .slice(0, limit)
    .map((entry) => {
      const command = commandOf(entry.pid, entry.comm);
      return {
        pid: entry.pid,
        ppid: entry.ppid,
        cpuPercent: cpu.get(entry.pid) ?? 0,
        memoryBytes: entry.rssBytes,
        name: processName(command),
        command,
        guarded: guarded.has(entry.pid),
      };
    });
  return { collectedAt: new Date().toISOString(), items };
}

export async function killProcessHandler({ pid, signal }: KillInput): Promise<KillOutput> {
  // The guard is recomputed from a fresh table on every call. The client's view
  // may be stale, and a PID it believes is safe may have been reused since.
  const table = readProcTable();
  const guarded = guardedPids(table, process.pid);
  const target = table.find((entry) => entry.pid === pid);

  const refuse = (error: string): KillOutput => ({
    ok: false,
    pid,
    signal,
    stillRunning: target !== undefined,
    error,
  });

  if (guarded.has(pid)) {
    return refuse("refused: this process is Paseo itself or one of its parents");
  }
  if (!target) {
    return refuse("no such process");
  }

  try {
    process.kill(pid, signal === "KILL" ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    console.error(`[machine-status] failed to signal ${pid}`, error);
    return refuse(describeError(error));
  }

  // SIGTERM is a request. Report honestly whether the process actually went away.
  await wait(400);
  return { ok: true, pid, signal, stillRunning: isAlive(pid), error: null };
}
