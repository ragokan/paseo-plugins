import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { applyEnv } from "./adapter";
import { chooseAccount, mostAvailable } from "./routing";
import { emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function account(partial: Partial<StoredAccount> & Pick<StoredAccount, "id">): StoredAccount {
  return {
    family: "claude",
    label: partial.id,
    autoLabel: false,
    kind: "managed",
    home: `/homes/${partial.id}`,
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function stateWith(accounts: StoredAccount[], patch: Partial<StoredState> = {}): StoredState {
  return { ...emptyState(), accounts, ...patch };
}

function usage(percent: number): Usage {
  return {
    fetchedAt: "2026-09-23T11:59:00Z",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }],
    error: null,
    cached: false,
    resets: null,
  };
}

const base = {
  agentId: "agent-1",
  family: "claude" as const,
  now: NOW,
  autoSwitch: true,
  balanceNewAgents: false,
};

describe("chooseAccount", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const personal = account({ id: "claude-personal" });

  it("uses the CLI login when nothing else is configured", () => {
    const decision = chooseAccount(stateWith([main, work]), { ...base, reason: "create", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.bind).toBeNull();
  });

  it("follows the chosen default", () => {
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("prefers the agent's own binding over the default", () => {
    const state = stateWith([main, work, personal], {
      defaults: { claude: "claude-work", codex: null },
      bindings: { "agent-1": { accountId: "claude-personal", source: "user", at: "x" } },
    });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-personal");
  });

  it("ignores a binding to a removed account", () => {
    const state = stateWith([main, work], {
      bindings: { "agent-1": { accountId: "claude-gone", source: "user", at: "x" } },
    });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-main");
  });

  it("skips an exhausted account for the roomiest usable one", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited, personal], { defaults: { claude: "claude-work", codex: null } });
    const decision = chooseAccount(state, {
      ...base,
      reason: "resume",
      usageOf: (id) => (id === "claude-main" ? usage(80) : usage(10)),
    });
    expect(decision?.account.id).toBe("claude-personal");
    expect(decision?.bind?.source).toBe("auto");
    expect(decision?.skipped?.why).toBe("limited");
  });

  it("keeps an exhausted account when automatic switching is off", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited], { defaults: { claude: "claude-work", codex: null } });
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
  });

  it("treats an expired limit as usable again", () => {
    const recovered = account({ id: "claude-work", limitedUntil: "2026-09-23T11:00:00Z" });
    const state = stateWith([main, recovered], { defaults: { claude: "claude-work", codex: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("spreads new agents by headroom when balancing", () => {
    const state = stateWith([main, work, personal]);
    const decision = chooseAccount(state, {
      ...base,
      balanceNewAgents: true,
      reason: "create",
      usageOf: (id) => ({ "claude-main": usage(60), "claude-work": usage(5), "claude-personal": usage(30) })[id],
    });
    expect(decision?.account.id).toBe("claude-work");
    expect(decision?.bind?.source).toBe("balance");
  });

  it("does not rebalance agents that already exist", () => {
    const state = stateWith([main, work]);
    const decision = chooseAccount(state, {
      ...base,
      balanceNewAgents: true,
      reason: "resume",
      usageOf: (id) => (id === "claude-work" ? usage(0) : usage(90)),
    });
    expect(decision?.account.id).toBe("claude-main");
  });

  it("returns null when the family has no accounts", () => {
    expect(chooseAccount(emptyState(), { ...base, reason: "create", usageOf: () => null })).toBeNull();
  });
});

describe("mostAvailable", () => {
  it("breaks ties toward the default account", () => {
    const main = account({ id: "claude-main", kind: "main", home: null });
    const work = account({ id: "claude-work" });
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null } });
    expect(mostAvailable(state, "claude", () => usage(20), NOW)?.id).toBe("claude-work");
  });

  it("spreads picks in a row instead of piling onto the roomiest account", () => {
    // work has a little more room, but three agents just opened on it; personal is about as roomy.
    const recent = { accountId: "claude-work", family: "claude" as const, openedAt: "2026-09-23T11:30:00Z" };
    const state = stateWith([account({ id: "claude-main", kind: "main", home: null }), account({ id: "claude-work" }), account({ id: "claude-personal" })], {
      sessions: { a: recent, b: recent, c: recent },
    });
    const usageOf = (id: string) => usage({ "claude-main": 60, "claude-work": 10, "claude-personal": 12 }[id] ?? 0);
    expect(mostAvailable(state, "claude", usageOf, NOW)?.id).toBe("claude-personal");
    // Sessions from before the 5-hour window are already in the usage readings.
    const old = { ...recent, openedAt: "2026-09-23T05:00:00Z" };
    expect(mostAvailable({ ...state, sessions: { a: old, b: old, c: old } }, "claude", usageOf, NOW)?.id).toBe("claude-work");
  });

  it("never picks a signed-out account", () => {
    const main = account({ id: "claude-main", kind: "main", home: null, signedIn: false });
    const state = stateWith([main]);
    expect(mostAvailable(state, "claude", () => usage(0), NOW)).toBeUndefined();
  });
});

describe("Codex", () => {
  it("keeps an agent an older release pinned to its thread on that account", () => {
    const main = account({ id: "codex-main", family: "codex", kind: "main", home: null });
    const state = stateWith([main], { bindings: { "agent-1": { accountId: "codex-main", source: "thread", at: "x" } } });
    const decision = chooseAccount(state, { ...base, family: "codex", reason: "resume", usageOf: () => null });
    expect(decision).toMatchObject({ account: { id: "codex-main" }, bind: null });
  });
});

describe("applyEnv", () => {
  it("sets values and drops inherited overrides", () => {
    expect(applyEnv({ CODEX_HOME: "/homes/work", CODEX_SQLITE_HOME: null }, { KEEP: "1", CODEX_SQLITE_HOME: "/x" })).toEqual({
      KEEP: "1",
      CODEX_HOME: "/homes/work",
    });
  });
});

describe("disabled accounts", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const off = { disabled: true };

  it("routes around a disabled account but keeps the agent's own binding", () => {
    const pinned = stateWith([main, account({ id: "claude-work", ...off })], {
      bindings: { "agent-1": { accountId: "claude-work", source: "user", at: "2026-09-23T00:00:00Z" } },
    });
    const decision = chooseAccount(pinned, { ...base, reason: "refresh", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.skipped?.why).toBe("disabled");
    expect(decision?.bind).toBeNull(); // so the agent returns once the account is enabled again
  });

  it("skips a disabled default even with automatic switching off", () => {
    const state = stateWith([account({ id: "claude-main", kind: "main", home: null, ...off }), work]);
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
    expect(decision?.bind).toBeNull();
  });

  it("is never the most available account", () => {
    const state = stateWith([main, account({ id: "claude-work", ...off })]);
    const usageOf = (id: string) => usage(id === "claude-main" ? 90 : 5);
    expect(mostAvailable(state, "claude", usageOf, NOW)?.id).toBe("claude-main");
  });
});
