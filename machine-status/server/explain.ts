import { readFileSync } from "node:fs";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { explainProcess } from "../shared/explain.ts";
import { classify, type ProcessEvidence } from "./explain-rules.ts";
import { collectMetrics } from "./metrics.ts";
import {
  commandOf,
  cwdOf,
  formatElapsed,
  procConstants,
  sampleProcesses,
  uptimeSeconds,
  type RawProcess,
} from "./proc.ts";
import { ancestorsOf, processName } from "./processes.ts";
import { readServicesHandler } from "./services.ts";

type Output = z.output<typeof explainProcess.output>;

function childrenOf<T extends { ppid: number }>(pid: number, table: readonly T[]): T[] {
  return table.filter((entry) => entry.ppid === pid);
}

/** The real user id from `/proc/<pid>/status`; null once the process is gone. */
function uidOf(pid: number): number | null {
  try {
    const match = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Below 1000 is a system account on Debian, Ubuntu, Fedora and Arch alike. */
const FIRST_LOGIN_UID = 1000;
const SYSTEM_PATH = /^(\/usr)?\/(sbin|lib|libexec)\//;

export async function explainProcessHandler(
  { pid }: { pid: number },
  context: PluginHandlerContext,
): Promise<Output> {
  const { table, cpu } = await sampleProcesses();
  const self = table.find((entry) => entry.pid === pid);

  if (!self) {
    return {
      found: false,
      name: `PID ${pid}`,
      pid,
      explanation: {
        headline: "This process no longer exists — it exited while you were looking at it.",
        kind: "unknown",
        state: "steady",
        concern: "none",
        findings: ["A process that short-lived is almost always scheduled work rather than a fault."],
        advice: ["Nothing to do. Refresh the list to see what is running now."],
      },
    };
  }

  const [metrics, services] = await Promise.all([collectMetrics(), readServicesHandler({}, context)]);

  const command = commandOf(pid, self.comm);
  const uid = uidOf(pid);
  const elapsedSeconds = Math.max(0, uptimeSeconds() - self.startTicks / procConstants().clockTicks);
  const children = childrenOf(pid, table);
  const childPids = new Set([pid, ...children.map((child) => child.pid)]);
  const nameOf = (entry: RawProcess) => processName(commandOf(entry.pid, entry.comm));

  const evidence: ProcessEvidence = {
    name: processName(command),
    pid,
    command,
    cpuPercent: cpu.get(pid) ?? 0,
    memoryBytes: self.rssBytes,
    elapsed: formatElapsed(elapsedSeconds),
    elapsedSeconds,
    cwd: cwdOf(pid) || null,
    parents: [...ancestorsOf(pid, table)]
      .filter((entry) => entry !== pid)
      .map((entry) => {
        const parent = table.find((row) => row.pid === entry);
        return { pid: entry, name: parent ? nameOf(parent) : "" };
      }),
    children: children.map((child) => ({
      pid: child.pid,
      name: nameOf(child),
      cpuPercent: cpu.get(child.pid) ?? 0,
    })),
    ports: services.ports
      .filter((port) => port.pid !== null && childPids.has(port.pid))
      .map((port) => ({ port: port.port, protocol: port.protocol, scope: port.scope })),
    isSystemBinary:
      command.startsWith("[") ||
      SYSTEM_PATH.test(command) ||
      (uid !== null && uid < FIRST_LOGIN_UID && uid !== process.getuid?.()),
    machine: {
      cores: metrics.cpu.cores,
      busyPercent: metrics.cpu.busyPercent,
      memoryStallPercent: metrics.memory.stallPercent,
      swapUsedBytes: metrics.swap.usedBytes,
      swapTotalBytes: metrics.swap.totalBytes,
    },
  };

  return {
    found: true,
    name: evidence.name,
    pid,
    explanation: classify(evidence),
  };
}
