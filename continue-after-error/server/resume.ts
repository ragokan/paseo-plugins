import type { PaseoCli } from "./paseo-cli.ts";
import { claim } from "./store.ts";
import { isDue, resumeMessage, toResume, type Turns } from "./turns.ts";

export interface ResumeOptions {
  /** The current records; hooks keep updating them while this runs. */
  turns: () => Turns;
  /** Drops an agent that was archived or deleted. */
  forget: (agentId: string) => void;
  directory: string;
  daemonPid: number;
  cli: PaseoCli;
  signal: AbortSignal;
  now?: number;
}

/** Sends a resume to every Claude and Codex agent whose last turn a daemon stop, crash or error cut short. */
export async function resumeCutOffTurns(options: ResumeOptions): Promise<string[]> {
  const { turns, forget, directory, daemonPid, cli, signal } = options;
  const now = options.now ?? Date.now();
  const due = Object.entries(turns()).filter(([, record]) => isDue(record, now));
  if (due.length === 0) return [];
  await cli.ready(signal);

  const resumed: string[] = [];
  for (const [agentId, record] of due) {
    if (signal.aborted) break;
    const agent = await cli.inspect(agentId, signal);
    if (!agent || agent.archived) {
      forget(agentId);
      continue;
    }
    // A turn that started since the daemon came up replaced the record, and a running agent needs no nudge.
    if (turns()[agentId] !== record || agent.status === "running") continue;
    const resume = toResume(record);
    if (!resume || !claim(directory, agentId, record.startedAt, daemonPid)) continue;
    await cli.send(agentId, resumeMessage(resume), signal);
    console.log(`[continue-after-error] resumed ${agentId}: ${resume.kind === "failed" ? `failed with ${resume.error}` : "cut off by the daemon stopping"}`);
    resumed.push(agentId);
  }
  return resumed;
}
