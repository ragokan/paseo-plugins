import type { PluginTurnOutcome } from "@getpaseo/plugin/server";

/** The providers whose cut-off turns this plugin resumes. */
export const PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);
/** A turn whose agent last did anything longer ago than this is left alone. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * A daemon shutdown cancels a running Claude turn and closes the agent milliseconds later, while a
 * Stop cancels it and leaves the agent open. (A shutdown just closes a running Codex agent, with no
 * turn end at all.)
 */
export const SHUTDOWN_CLOSE_MS = 3000;

/** What the plugin last saw of an agent's turn. Times are epoch milliseconds. */
export interface TurnRecord {
  provider: string;
  /** "running" from the turn's start until its end; a daemon crash or a Codex shutdown leaves it there. */
  state: "running" | PluginTurnOutcome["kind"];
  startedAt: number;
  endedAt?: number;
  error?: string;
  closedAt?: number;
}

export type Turns = Record<string, TurnRecord>;

export type Resume = { kind: "interrupted" } | { kind: "failed"; error: string };

export function turnStarted(turns: Turns, agentId: string, provider: string, now: number): Turns {
  return { ...turns, [agentId]: { provider, state: "running", startedAt: now } };
}

export function turnEnded(turns: Turns, agentId: string, provider: string, outcome: PluginTurnOutcome, now: number): Turns {
  const previous = turns[agentId];
  const record: TurnRecord = { provider, state: outcome.kind, startedAt: previous?.startedAt ?? now, endedAt: now };
  if (outcome.kind === "failed") record.error = outcome.error.message;
  // Hook callbacks can finish out of order, so a shutdown's close may land before its cancel.
  if (previous?.state === "running" && previous.closedAt !== undefined) record.closedAt = previous.closedAt;
  return { ...turns, [agentId]: record };
}

export function agentClosed(turns: Turns, agentId: string, now: number): Turns {
  const record = turns[agentId];
  return record ? { ...turns, [agentId]: { ...record, closedAt: now } } : turns;
}

export function agentArchived(turns: Turns, agentId: string): Turns {
  if (!(agentId in turns)) return turns;
  const { [agentId]: _archived, ...rest } = turns;
  return rest;
}

/** Why this turn should be picked back up, or null when it finished or the user stopped it. */
export function toResume(record: TurnRecord): Resume | null {
  switch (record.state) {
    case "running":
      return { kind: "interrupted" };
    case "failed":
      return { kind: "failed", error: record.error ?? "unknown error" };
    case "canceled":
      return record.endedAt !== undefined &&
        record.closedAt !== undefined &&
        Math.abs(record.closedAt - record.endedAt) <= SHUTDOWN_CLOSE_MS
        ? { kind: "interrupted" }
        : null;
    default:
      return null;
  }
}

/** When the agent last did something. A later close is the daemon's doing, except for a turn still running. */
export function lastActivity(record: TurnRecord): number {
  if (record.state === "running") return record.closedAt ?? record.startedAt;
  return record.endedAt ?? record.startedAt;
}

export function isDue(record: TurnRecord, now: number): boolean {
  return PROVIDERS.has(record.provider) && now - lastActivity(record) <= MAX_AGE_MS && toResume(record) !== null;
}

/** Records past the age limit can never be resumed. */
export function prune(turns: Turns, now: number): Turns {
  return Object.fromEntries(Object.entries(turns).filter(([, record]) => now - lastActivity(record) <= MAX_AGE_MS));
}

export function resumeMessage(resume: Resume): string {
  if (resume.kind === "interrupted") {
    return "Your previous turn was cut off when the Paseo daemon stopped. Continue where you left off.";
  }
  const error = resume.error.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const shown = error.length > 300 ? `${error.slice(0, 300)}…` : error;
  return `Your previous turn ended with an error: ${shown}. Continue where you left off.`;
}
