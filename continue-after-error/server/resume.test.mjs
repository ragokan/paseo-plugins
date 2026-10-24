// The startup scan against a fake `paseo` CLI and a temporary data directory.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { resumeCutOffTurns } = await import("./resume.ts");

const NOW = 1_000_000_000;
const running = (provider = "claude") => ({ provider, state: "running", startedAt: NOW - 60_000 });

function fakeCli(agents) {
  const sent = [];
  return {
    sent,
    async ready() {},
    async inspect(agentId) {
      return agents[agentId] ?? null;
    },
    async send(agentId, message) {
      sent.push([agentId, message]);
    },
  };
}

async function scan(turns, agents, overrides = {}) {
  const directory = overrides.directory ?? mkdtempSync(path.join(tmpdir(), "continue-after-error-"));
  const state = { turns };
  const cli = fakeCli(agents);
  const resumed = await resumeCutOffTurns({
    turns: () => state.turns,
    forget: (agentId) => {
      const { [agentId]: _gone, ...rest } = state.turns;
      state.turns = rest;
    },
    directory,
    daemonPid: overrides.daemonPid ?? 42,
    cli,
    signal: new AbortController().signal,
    now: NOW,
  });
  if (!overrides.directory) rmSync(directory, { recursive: true, force: true });
  return { resumed, sent: cli.sent, turns: state.turns };
}

test("resumes a cut-off turn and a failed one", async () => {
  const failed = { provider: "codex", state: "failed", error: "stream disconnected", startedAt: NOW - 5000, endedAt: NOW - 1000 };
  const { sent } = await scan({ a: running(), b: failed }, { a: { status: "closed", archived: false }, b: { status: "closed", archived: false } });
  assert.deepEqual(sent, [
    ["a", "Your previous turn was cut off when the Paseo daemon stopped. Continue where you left off."],
    ["b", "Your previous turn ended with an error: stream disconnected. Continue where you left off."],
  ]);
});

test("leaves stopped and finished turns alone, and asks the daemon nothing", async () => {
  const stopped = { provider: "claude", state: "canceled", startedAt: NOW - 5000, endedAt: NOW - 4000 };
  const finished = { provider: "claude", state: "completed", startedAt: NOW - 5000, endedAt: NOW - 4000 };
  const cli = await scan({ a: stopped, b: finished }, {});
  assert.deepEqual(cli.sent, []);
});

test("forgets archived and deleted agents without resuming them", async () => {
  const { sent, turns } = await scan({ a: running(), b: running() }, { a: { status: "closed", archived: true } });
  assert.deepEqual(sent, []);
  assert.deepEqual(turns, {});
});

test("skips an agent that is already running again", async () => {
  const { sent } = await scan({ a: running() }, { a: { status: "running", archived: false } });
  assert.deepEqual(sent, []);
});

test("resumes each turn once when two copies of the plugin run", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "continue-after-error-"));
  const agents = { a: { status: "closed", archived: false } };
  const turns = { a: running() };
  const first = await scan(turns, agents, { directory });
  const second = await scan(turns, agents, { directory });
  const nextDaemon = await scan(turns, agents, { directory, daemonPid: 43 });
  rmSync(directory, { recursive: true, force: true });
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 0, "the second copy finds the claim");
  assert.equal(nextDaemon.sent.length, 1, "the next daemon run tries again");
});
