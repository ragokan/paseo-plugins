// The event sequences below are what Paseo 0.13.0 sent the plugin in a live run.
import assert from "node:assert/strict";
import { test } from "node:test";

const { agentArchived, agentClosed, isDue, MAX_AGE_MS, prune, resumeMessage, toResume, turnEnded, turnStarted } = await import("./turns.ts");

const HOUR = 60 * 60 * 1000;
const canceled = { kind: "canceled", reason: "Interrupted" };

function replay(steps) {
  let turns = {};
  for (const [at, step, value] of steps) {
    if (step === "start") turns = turnStarted(turns, "a", "claude", at);
    if (step === "end") turns = turnEnded(turns, "a", "claude", value, at);
    if (step === "close") turns = agentClosed(turns, "a", at);
  }
  return turns.a;
}

test("a Stop leaves the agent open, so it is not resumed", () => {
  assert.equal(toResume(replay([[0, "start"], [14_000, "end", canceled]])), null);
});

test("a Stop long before the daemon shuts down is still a Stop", () => {
  assert.equal(toResume(replay([[0, "start"], [14_000, "end", canceled], [2 * HOUR, "close"]])), null);
});

test("a shutdown cancels Claude's turn and closes the agent at once", () => {
  assert.deepEqual(toResume(replay([[0, "start"], [13_000, "end", canceled], [13_023, "close"]])), { kind: "interrupted" });
});

test("the close can land before the cancel", () => {
  assert.deepEqual(toResume(replay([[0, "start"], [13_000, "close"], [13_010, "end", canceled]])), { kind: "interrupted" });
});

test("a shutdown closes Codex's running agent with no turn end", () => {
  assert.deepEqual(toResume(replay([[0, "start"], [13_000, "close"]])), { kind: "interrupted" });
});

test("a crash leaves the turn running", () => {
  assert.deepEqual(toResume(replay([[0, "start"]])), { kind: "interrupted" });
});

test("a finished turn is not resumed, even when the daemon closes it", () => {
  assert.equal(toResume(replay([[0, "start"], [5_000, "end", { kind: "completed" }], [5_010, "close"]])), null);
});

test("a failed turn is resumed with its error", () => {
  const record = replay([[0, "start"], [5_000, "end", { kind: "failed", error: { message: "API overloaded" } }]]);
  assert.deepEqual(toResume(record), { kind: "failed", error: "API overloaded" });
});

test("a new turn forgets the last one's close", () => {
  const record = replay([[0, "start"], [1_000, "end", canceled], [1_010, "close"], [5_000, "start"], [9_000, "end", canceled]]);
  assert.equal(toResume(record), null);
});

test("only Claude and Codex agents active in the last day are due", () => {
  const now = 10 * 24 * HOUR;
  const running = (provider, startedAt) => ({ provider, state: "running", startedAt });
  assert.equal(isDue(running("claude", now - HOUR), now), true);
  assert.equal(isDue(running("codex", now - HOUR), now), true);
  assert.equal(isDue(running("opencode", now - HOUR), now), false);
  assert.equal(isDue(running("claude", now - MAX_AGE_MS - 1), now), false);
});

test("a shutdown's close does not make an old failure recent", () => {
  const now = 10 * 24 * HOUR;
  const record = { provider: "claude", state: "failed", error: "x", startedAt: now - 3 * 24 * HOUR, endedAt: now - 3 * 24 * HOUR, closedAt: now - HOUR };
  assert.equal(isDue(record, now), false);
  assert.deepEqual(prune({ a: record }, now), {});
});

test("a Codex turn running until a shutdown counts from the shutdown", () => {
  const now = 10 * 24 * HOUR;
  const record = { provider: "codex", state: "running", startedAt: now - 2 * MAX_AGE_MS, closedAt: now - HOUR };
  assert.equal(isDue(record, now), true);
});

test("archiving forgets the agent", () => {
  const turns = turnStarted({}, "a", "claude", 0);
  assert.deepEqual(agentArchived(turns, "a"), {});
  assert.equal(agentArchived(turns, "b"), turns, "unchanged when unknown");
});

test("the resume message explains why", () => {
  assert.equal(resumeMessage({ kind: "interrupted" }), "Your previous turn was cut off when the Paseo daemon stopped. Continue where you left off.");
  assert.equal(
    resumeMessage({ kind: "failed", error: "API Error: 529\n  overloaded." }),
    "Your previous turn ended with an error: API Error: 529 overloaded. Continue where you left off.",
  );
  assert.ok(resumeMessage({ kind: "failed", error: "x".repeat(1000) }).includes(`${"x".repeat(300)}…`));
});
