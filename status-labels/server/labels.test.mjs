import assert from "node:assert/strict";
import { test } from "node:test";

const { IDLE_FOR, labelChanges, labelFor, nextIdleEnd, waitingWorkspaces } = await import("./labels.ts");

const NOW = Date.parse("2026-10-24T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const none = new Set();

test("Paseo's statuses get their group's label", () => {
  const label = (status) => labelFor({ id: "w", status, statusEnteredAt: ago(HOUR) }, NOW, none, {});
  assert.equal(label("needs_input"), "Input");
  assert.equal(label("failed"), "Failed");
  assert.equal(label("running"), "Working");
  assert.equal(label("attention"), "Review");
  assert.equal(label("something_new"), null, "a status this plugin does not know gets none");
});

test("Done waits in Idle for a day, unless marked as done", () => {
  const done = (enteredAgo) => ({ id: "w", status: "done", statusEnteredAt: ago(enteredAgo) });
  assert.equal(labelFor(done(HOUR), NOW, none, {}), "Idle");
  assert.equal(labelFor(done(IDLE_FOR - 1), NOW, none, {}), "Idle");
  assert.equal(labelFor(done(IDLE_FOR), NOW, none, {}), "Done");
  assert.equal(labelFor(done(HOUR), NOW, none, { w: NOW - HOUR }), "Done", "marked as done");
  assert.equal(labelFor(done(HOUR), NOW, none, { w: NOW - 2 * HOUR }), "Idle", "a mark from an earlier time in Done does not count");
  assert.equal(labelFor({ id: "w", status: "done", statusEnteredAt: null }, NOW, none, {}), "Done", "no time in Done");
});

test("Done waiting on a subagent is Waiting, before Idle", () => {
  const workspace = { id: "w", status: "done", statusEnteredAt: ago(HOUR) };
  assert.equal(labelFor(workspace, NOW, new Set(["w"]), {}), "Waiting");
  assert.equal(labelFor({ ...workspace, status: "running" }, NOW, new Set(["w"]), {}), "Working", "only Done splits");
});

test("the next end of Idle is the earliest, leaving out Waiting and marked ones", () => {
  const workspaces = [
    { id: "a", status: "done", statusEnteredAt: ago(2 * HOUR) },
    { id: "b", status: "done", statusEnteredAt: ago(5 * HOUR) },
    { id: "c", status: "done", statusEnteredAt: ago(9 * HOUR) },
    { id: "d", status: "done", statusEnteredAt: ago(IDLE_FOR + HOUR) },
    { id: "e", status: "running", statusEnteredAt: ago(20 * HOUR) },
  ];
  assert.equal(nextIdleEnd(workspaces, NOW, new Set(["c"]), {}), NOW - 5 * HOUR + IDLE_FOR);
  assert.equal(nextIdleEnd(workspaces, NOW, new Set(["c"]), { b: NOW - 5 * HOUR }), NOW - 2 * HOUR + IDLE_FOR);
  assert.equal(nextIdleEnd(workspaces.slice(3), NOW, none, {}), null);
});

test("a workspace waits while an agent it started, or one those started, works", () => {
  const agents = new Map([
    ["parent", { workspaceId: "w1", parentId: null, working: false }],
    ["child", { workspaceId: "w2", parentId: "parent", working: false }],
    ["grandchild", { workspaceId: "w3", parentId: "child", working: true }],
    ["idle", { workspaceId: "w4", parentId: null, working: false }],
    ["idle-child", { workspaceId: "w5", parentId: "idle", working: false }],
  ]);
  assert.deepEqual([...waitingWorkspaces(agents)].sort(), ["w1", "w2"]);
  // A loop in the parent labels does not hang.
  const loop = new Map([
    ["a", { workspaceId: "w1", parentId: "b", working: false }],
    ["b", { workspaceId: "w2", parentId: "a", working: false }],
  ]);
  assert.deepEqual([...waitingWorkspaces(loop)], []);
});

test("changes swap this plugin's label and leave the others", () => {
  assert.deepEqual(labelChanges(["mine", "Working"], "Review"), { remove: ["Working"], add: "Review" });
  assert.deepEqual(labelChanges(["Review", "mine"], "Review"), { remove: [], add: null });
  assert.deepEqual(labelChanges(["review"], "Review"), { remove: [], add: null }, "names match as Paseo matches them");
  assert.deepEqual(labelChanges(["Idle", "Done"], "Done"), { remove: ["Idle"], add: null });
  assert.deepEqual(labelChanges(["mine", "Idle"], null), { remove: ["Idle"], add: null }, "switched off");
  assert.deepEqual(labelChanges([], "Input"), { remove: [], add: "Input" });
});
