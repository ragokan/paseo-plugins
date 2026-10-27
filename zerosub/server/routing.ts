import { peakUsage } from "../shared/format";
import type { Family, Usage } from "../shared/model";
import {
  accountsOf,
  defaultAccount,
  findAccount,
  type Binding,
  type StoredAccount,
  type StoredState,
} from "./state";

export function isLimited(account: StoredAccount, now: number): boolean {
  if (!account.limitedUntil) return false;
  const until = Date.parse(account.limitedUntil);
  return Number.isFinite(until) && until > now;
}

export function isUsable(account: StoredAccount, now: number): boolean {
  return account.signedIn && !account.disabled && !isLimited(account, now);
}

/**
 * Points of usage each session opened on an account in the last 5 hours counts for, so agents moved
 * one after another spread out: the usage readings don't change between picks. Older sessions are
 * in the readings already.
 */
const SESSION_LOAD = 5;
const SESSION_WINDOW_MS = 5 * 60 * 60_000;

/** Lower is better. Unknown usage ranks in the middle so a known-quiet account wins over a mystery. */
export function headroomScore(usage: Usage | null | undefined): number {
  const peak = usage ? peakUsage(usage.windows) : null;
  return peak ? peak.usedPercent : 50;
}

/** The usable account with the most room, less its recent sessions, preferring the default, then the CLI login, on ties. */
export function mostAvailable(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const candidates = accountsOf(state, family).filter(
    (account) => !exclude.has(account.id) && isUsable(account, now),
  );
  const recent = new Map<string, number>();
  for (const session of Object.values(state.sessions)) {
    if (now - (Date.parse(session.openedAt) || 0) < SESSION_WINDOW_MS) recent.set(session.accountId, (recent.get(session.accountId) ?? 0) + 1);
  }
  const rank = (account: StoredAccount) => [
    headroomScore(usageOf(account.id)) + SESSION_LOAD * (recent.get(account.id) ?? 0),
    account.id === preferred ? 0 : 1,
    account.kind === "main" ? 0 : 1,
    Date.parse(account.createdAt) || 0,
  ];
  candidates.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return candidates[0];
}

export interface RouteInput {
  agentId: string;
  family: Family;
  reason: "create" | "resume" | "refresh" | "import";
  now: number;
  autoSwitch: boolean;
  balanceNewAgents: boolean;
  usageOf(accountId: string): Usage | null | undefined;
}

export interface RouteDecision {
  account: StoredAccount;
  /** A binding to persist so the agent stays where it was routed. */
  bind: Binding | null;
  /** Why the preferred account was skipped, if it was. */
  skipped: { account: StoredAccount; why: "limited" | "signed_out" | "disabled" } | null;
}

/**
 * Which account a session opens on: the agent's own binding, else (for balanced new agents) the
 * roomiest account, else the default. An exhausted or signed-out choice is swapped for the roomiest
 * usable account when automatic switching is on. A disabled choice is always swapped, and the agent
 * keeps its own binding so it returns once the account is enabled again.
 */
export function chooseAccount(state: StoredState, input: RouteInput): RouteDecision | null {
  const accounts = accountsOf(state, input.family);
  if (accounts.length === 0) return null;
  const at = new Date(input.now).toISOString();
  const fresh = input.reason === "create";

  const binding = state.bindings[input.agentId];
  const bound = findAccount(state, binding?.accountId);
  let account = bound && bound.family === input.family ? bound : undefined;
  let bind: Binding | null = null;

  if (!account && fresh && input.balanceNewAgents && accounts.length > 1) {
    account = mostAvailable(state, input.family, input.usageOf, input.now);
    if (account) bind = { accountId: account.id, source: "balance", at };
  }
  account ??= defaultAccount(state, input.family);
  if (!account) return null;

  let skipped: RouteDecision["skipped"] = null;
  const why = !account.signedIn ? "signed_out" : account.disabled ? "disabled" : isLimited(account, input.now) ? "limited" : null;
  if (why && (input.autoSwitch || why !== "limited")) {
    const alternative = mostAvailable(state, input.family, input.usageOf, input.now, new Set([account.id]));
    if (alternative) {
      skipped = { account, why };
      account = alternative;
      // A disabled account keeps its agents' bindings, so they return when it's enabled again; a
      // limit re-pins them.
      bind = why === "disabled" ? null : { accountId: alternative.id, source: "auto", at };
    }
  }
  return { account, bind, skipped };
}
