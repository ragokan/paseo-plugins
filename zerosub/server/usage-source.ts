import { createHash } from "node:crypto";
import { z } from "zod";
import { formatAge, formatPlan } from "../shared/format";
import type { Usage } from "../shared/model";
import type { StoredAccount } from "./state";

// Paseo's usage sources (Paseo 0.11 and later), declared here because ZeroSub builds against an
// older SDK. They match `@getpaseo/plugin/server/usage`.
export type UsageReport =
  | {
      status: "available";
      planLabel?: string;
      windows: Array<{ id: string; label: string; shortLabel?: string; summary?: boolean; usedPct: number; remainingPct: number; resetsAt: string | null }>;
      details?: Array<{ id: string; label: string; value: string }>;
    }
  | { status: "error"; error: string };
export interface UsageAccount {
  key: string;
  label?: string;
  input: UsageInput;
}
export interface UsageSources {
  registerUsageSource?(source: {
    id: string;
    label: string;
    input: z.ZodType;
    discover(scope: { kind: string }): Promise<UsageAccount[]>;
    fetch(input: unknown): Promise<UsageReport>;
  }): void;
}

export const UsageInputSchema = z.object({ accountId: z.string() });
export type UsageInput = z.infer<typeof UsageInputSchema>;

/** Same account, same key, on every host and whatever ZeroSub calls it there. Never the raw email. */
export function usageKey(account: Pick<StoredAccount, "family" | "id" | "identity">): string {
  return createHash("sha256")
    .update(account.identity ?? `${account.family}:${account.id}`)
    .digest("hex")
    .slice(0, 32);
}

/** "5-hour" → "5h", "Weekly" → "wk", "Weekly · Fable" → "wk Fable", as Paseo's own cards say it. */
export function shortWindowLabel(label: string): string {
  const span = /^(\d+)-(minute|hour|day)$/.exec(label);
  if (span) return `${span[1]}${span[2]![0]}`;
  if (label === "Weekly") return "wk";
  if (label.startsWith("Weekly · ")) return `wk ${label.slice("Weekly · ".length)}`;
  return label;
}

/** The account's last reading as a usage card; how old it is goes under the bars. */
export function usageReport(account: Pick<StoredAccount, "signedIn" | "plan">, usage: Usage | null, now = Date.now()): UsageReport {
  if (!account.signedIn) return { status: "error", error: "Signed out. Sign in again under Accounts (ZeroSub)." };
  if (!usage || usage.windows.length === 0) return { status: "error", error: usage?.error ?? "No usage reading yet." };
  const plan = formatPlan(account.plan);
  return {
    status: "available",
    ...(plan ? { planLabel: plan } : {}),
    windows: usage.windows.map((window) => ({
      id: window.id,
      label: window.label,
      shortLabel: shortWindowLabel(window.label),
      // Model-scoped weekly windows stay out of the summary, as on Paseo's own cards.
      summary: !window.label.includes("·"),
      usedPct: window.usedPercent,
      remainingPct: Math.max(0, 100 - window.usedPercent),
      resetsAt: window.resetsAt,
    })),
    details: [{ id: "read", label: "Read", value: formatAge(usage.fetchedAt, now) }],
  };
}
