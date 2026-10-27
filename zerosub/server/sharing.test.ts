import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Family, Usage } from "../shared/model";
import type { FamilyAdapter, UsageRead } from "./adapter";
import { Peers, type Hosts, type SharedReading } from "./peers";
import { Service } from "./service";
import { StateStore } from "./state";
import { shortWindowLabel, usageKey, usageReport } from "./usage-source";

const OKAN = "org|okan@example.com";
const DEV = "org|dev@example.com";

function reading(minutesAgo: number, usedPercent = 40): Usage {
  return {
    fetchedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    windows: [
      { id: "five_hour", label: "5-hour", usedPercent, resetsAt: new Date(Date.now() + 60 * 60_000).toISOString() },
      { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 3, resetsAt: null },
    ],
    error: null,
    cached: false,
    resets: null,
  };
}

/** Hosts as this one's daemon sees them; `answers` is what each host's ZeroSub says, or how it fails. */
function fakeHosts(
  self: string,
  answers: Record<string, SharedReading[] | Error | "silent">,
  offline: string[] = [],
): Hosts & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    self: async () => [self, `srv_${self}`],
    list: async () =>
      ["ragdevbox", "ragmini", "ragair"]
        .filter((name) => name !== self)
        .map((name) => ({ serverId: `srv_${name}`, label: name, online: !offline.includes(name) })),
    readings: async (serverId) => {
      const name = serverId.slice("srv_".length);
      asked.push(name);
      const answer = answers[name];
      if (answer === "silent") return new Promise(() => undefined);
      if (answer instanceof Error) throw answer;
      return { readings: answer ?? [] };
    },
    close: async () => undefined,
  };
}

const ORDER = ["ragdevbox", "ragmini", "ragair"];
const tenMinutesAgo = () => Date.now() - 10 * 60_000;

describe("readings from other hosts", () => {
  it("asks the hosts before this one, in order, and takes the first recent reading", async () => {
    const hosts = fakeHosts("ragair", {
      ragdevbox: [{ family: "claude", identity: OKAN, usage: reading(2, 57) }],
      ragmini: [{ family: "claude", identity: OKAN, usage: reading(1, 60) }],
    });
    const peers = new Peers(hosts);
    peers.setOrder(ORDER);
    expect((await peers.reading("claude", OKAN, tenMinutesAgo()))?.windows[0]?.usedPercent).toBe(57);
    expect(hosts.asked).toEqual(["ragdevbox"]);
  });

  it("goes on to the next host when one is offline, failing, silent or out of date", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const minis = [{ family: "claude" as Family, identity: OKAN, usage: reading(1, 61) }];
      const cases: Array<[string, Hosts & { asked: string[] }]> = [
        ["offline", fakeHosts("ragair", { ragdevbox: [], ragmini: minis }, ["ragdevbox"])],
        ["failing", fakeHosts("ragair", { ragdevbox: new Error("Host route failed"), ragmini: minis })],
        ["silent", fakeHosts("ragair", { ragdevbox: "silent", ragmini: minis })],
        ["out of date", fakeHosts("ragair", { ragdevbox: [{ family: "claude", identity: OKAN, usage: reading(30) }], ragmini: minis })],
      ];
      for (const [why, hosts] of cases) {
        const peers = new Peers(hosts);
        peers.setOrder(ORDER);
        const pending = peers.reading("claude", OKAN, tenMinutesAgo());
        await vi.advanceTimersByTimeAsync(5_000);
        expect((await pending)?.windows[0]?.usedPercent, why).toBe(61);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nobody from the first host in the order", async () => {
    const hosts = fakeHosts("ragdevbox", { ragmini: [{ family: "claude", identity: OKAN, usage: reading(1) }] });
    const peers = new Peers(hosts);
    peers.setOrder(ORDER);
    expect(await peers.reading("claude", OKAN, tenMinutesAgo())).toBeNull();
    expect(hosts.asked).toEqual([]);
  });

  it("matches the account by family and identity, whatever each host calls it", async () => {
    const hosts = fakeHosts("ragmini", {
      ragdevbox: [
        { family: "codex", identity: OKAN, usage: reading(1, 19) },
        { family: "claude", identity: DEV, usage: reading(1, 48) },
      ],
    });
    const peers = new Peers(hosts);
    peers.setOrder(ORDER);
    expect((await peers.reading("claude", DEV, tenMinutesAgo()))?.windows[0]?.usedPercent).toBe(48);
    expect(await peers.reading("claude", OKAN, tenMinutesAgo())).toBeNull();
    // One question per host per round of polls.
    expect(hosts.asked).toEqual(["ragdevbox"]);
  });

  it("never throws, even when its own daemon can't be reached", async () => {
    const hosts = fakeHosts("ragair", {});
    hosts.self = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:6767");
    };
    const peers = new Peers(hosts);
    peers.setOrder(ORDER);
    expect(await peers.reading("claude", OKAN, tenMinutesAgo())).toBeNull();
  });

  it("does nothing until a host order is set", async () => {
    const hosts = fakeHosts("ragair", { ragdevbox: [{ family: "claude", identity: OKAN, usage: reading(1) }] });
    expect(await new Peers(hosts).reading("claude", OKAN, tenMinutesAgo())).toBeNull();
    expect(hosts.asked).toEqual([]);
  });
});

describe("usage polling with shared readings", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zerosub-sharing-"));
    previousHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = root;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  async function setUp(shared: Usage | null) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) => {
      draft.accounts = [
        { id: "claude-main", family: "claude", label: "okan", kind: "main", home: null, identity: OKAN, signedIn: true, createdAt: "2026-10-01T00:00:00.000Z" },
      ] as never;
    });
    const live = vi.fn(async (): Promise<UsageRead> => reading(0, 20));
    const adapter = { family: "claude", usageSpacingMs: 0, usage: live } as unknown as FamilyAdapter;
    const peers = { reading: vi.fn(async () => shared), setOrder: () => undefined, stop: async () => undefined };
    const service = new Service({ claude: adapter, codex: adapter }, store, undefined, undefined, peers as unknown as Peers);
    return { service, store, live, peers };
  }

  it("takes another host's recent reading instead of asking the provider", async () => {
    const { service, live, peers } = await setUp(reading(2, 57));
    await service.refreshUsage("claude-main", false, false, 5 * 60_000);
    expect(peers.reading).toHaveBeenCalledWith("claude", OKAN, expect.any(Number));
    expect(live).not.toHaveBeenCalled();
    const report = await service.usageReport("claude-main");
    expect(report.status === "available" && report.windows[0]?.usedPct).toBe(57);
    // And passes it on to the hosts after this one.
    expect((await service.sharedReadings())[0]?.usage.windows[0]?.usedPercent).toBe(57);
  });

  it("asks the provider when no host has a recent reading", async () => {
    const { service, live } = await setUp(null);
    await service.refreshUsage("claude-main", false, false, 5 * 60_000);
    expect(live).toHaveBeenCalledOnce();
  });

  it("reads the account itself on a forced refresh", async () => {
    const { service, live, peers } = await setUp(reading(1));
    await service.refreshUsage("claude-main", true);
    expect(peers.reading).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledOnce();
  });

  it("marks the account limited when the shared reading shows a full window", async () => {
    const { service, store } = await setUp(reading(1, 100));
    await service.refreshUsage("claude-main", false, false, 5 * 60_000);
    expect((await store.read()).accounts[0]?.limitedUntil).toBeTruthy();
  });

  it("lists every account for Paseo's usage display, keyed by identity", async () => {
    const { service } = await setUp(null);
    const accounts = await service.usageAccounts("claude");
    expect(accounts).toEqual([{ key: usageKey({ family: "claude", id: "other-id", identity: OKAN }), label: "okan", input: { accountId: "claude-main" } }]);
    expect(accounts[0]?.key).not.toContain("okan");
    expect(await service.usageReport("claude-main")).toEqual({ status: "error", error: "No usage reading yet." });
  });
});

describe("usage cards", () => {
  it("names windows the way Paseo's own cards do", () => {
    expect(["5-hour", "Weekly", "Weekly · Fable", "7-day", "30-minute", "Usage"].map(shortWindowLabel)).toEqual([
      "5h",
      "wk",
      "wk Fable",
      "7d",
      "30m",
      "Usage",
    ]);
  });

  it("shows the last reading and how old it is, or why there is none", () => {
    const now = Date.now();
    const report = usageReport({ signedIn: true, plan: "max" }, reading(12, 57), now);
    expect(report).toMatchObject({
      status: "available",
      planLabel: "Max",
      windows: [
        { id: "five_hour", shortLabel: "5h", summary: true, usedPct: 57, remainingPct: 43 },
        { id: "weekly_fable", shortLabel: "wk Fable", summary: false, usedPct: 3 },
      ],
      details: [{ id: "read", label: "Read", value: "12m ago" }],
    });
    expect(usageReport({ signedIn: false, plan: null }, reading(1), now).status).toBe("error");
    expect(usageReport({ signedIn: true, plan: null }, { ...reading(1), windows: [], error: "HTTP 500" }, now)).toEqual({
      status: "error",
      error: "HTTP 500",
    });
  });
});
