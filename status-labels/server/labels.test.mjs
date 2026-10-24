import assert from "node:assert/strict";
import { test } from "node:test";

const { doneSince, IDLE_FOR, labelChanges, labelFor, nextIdleEnd, waitingWorkspaces } = await import("./labels.ts");

const NOW = Date.parse("2026-10-24T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const none = new Set();

// labelFor as the plugin calls it, with the times in Done worked out from the workspaces alone.
const labelOf = (workspace, waiting = none, marks = {}, previous = {}) =>
  labelFor(workspace, NOW, waiting, doneSince(previous, [workspace], marks), marks);

test("Paseo's statuses get their group's label", () => {
  const label = (status) => labelOf({ id: "w", status, statusEnteredAt: ago(HOUR) });
  assert.equal(label("needs_input"), "Input");
  assert.equal(label("failed"), "Failed");
  assert.equal(label("running"), "Working");
  assert.equal(label("attention"), "Review");
  assert.equal(label("something_new"), null, "a status this plugin does not know gets none");
});

test("Done waits in Idle for a day, unless marked as done", () => {
  const done = (enteredAgo) => ({ id: "w", status: "done", statusEnteredAt: ago(enteredAgo) });
  assert.equal(labelOf(done(HOUR)), "Idle");
  assert.equal(labelOf(done(IDLE_FOR - 1)), "Idle");
  assert.equal(labelOf(done(IDLE_FOR)), "Done");
  assert.equal(labelOf(done(HOUR), none, { w: NOW - HOUR }), "Done", "marked as done");
  assert.equal(labelOf(done(HOUR), none, { w: NOW - HOUR + 5000 }), "Done", "the app stamps its own time, a moment apart");
  assert.equal(labelOf(done(HOUR), none, { w: NOW - 3 * HOUR }, { w: null }), "Idle", "a mark from an earlier stay in Done does not count");
  assert.equal(labelOf({ id: "w", status: "done", statusEnteredAt: null }), "Done", "no time in Done");
});

test("Done waiting on a subagent is Waiting, before Idle", () => {
  const workspace = { id: "w", status: "done", statusEnteredAt: ago(HOUR) };
  assert.equal(labelOf(workspace, new Set(["w"])), "Waiting");
  assert.equal(labelOf({ ...workspace, status: "running" }, new Set(["w"])), "Working", "only Done splits");
});

test("the next end of Idle is the earliest, leaving out Waiting and marked ones", () => {
  const workspaces = [
    { id: "a", status: "done", statusEnteredAt: ago(2 * HOUR) },
    { id: "b", status: "done", statusEnteredAt: ago(5 * HOUR) },
    { id: "c", status: "done", statusEnteredAt: ago(9 * HOUR) },
    { id: "d", status: "done", statusEnteredAt: ago(IDLE_FOR + HOUR) },
    { id: "e", status: "running", statusEnteredAt: ago(20 * HOUR) },
  ];
  const since = doneSince({}, workspaces, {});
  assert.equal(nextIdleEnd(workspaces, NOW, new Set(["c"]), since, {}), NOW - 5 * HOUR + IDLE_FOR);
  assert.equal(nextIdleEnd(workspaces, NOW, new Set(["c"]), since, { b: NOW - 5 * HOUR }), NOW - 2 * HOUR + IDLE_FOR);
  assert.equal(nextIdleEnd(workspaces.slice(3), NOW, none, since, {}), null);
});

// Paseo works statusEnteredAt out again for every connection, so a daemon restart or a reopened chat
// moves it later than the app's.
test("a later time for the same stay in Done keeps the earlier one", () => {
  const before = { w: NOW - 30 * HOUR };
  const bumped = { id: "w", status: "done", statusEnteredAt: ago(HOUR), lastUserMessageAt: ago(31 * HOUR) };
  assert.deepEqual(doneSince(before, [bumped], {}), { w: NOW - 30 * HOUR });
  assert.equal(labelFor(bumped, NOW, none, doneSince(before, [bumped], {}), {}), "Done");
  // A message from you starts a new stay, and so does leaving Done.
  assert.deepEqual(doneSince(before, [{ ...bumped, lastUserMessageAt: ago(2 * HOUR) }], {}), { w: NOW - HOUR });
  assert.deepEqual(doneSince(before, [{ ...bumped, status: "running" }], {}), { w: null });
  assert.deepEqual(doneSince({ w: null }, [bumped], {}), { w: NOW - HOUR });
  // Workspaces no longer listed are forgotten.
  assert.deepEqual(doneSince({ gone: NOW }, [], {}), {});
});

// ragmini's "LinkedIn reply messages" on 2026-10-24: the app showed it in Done, entered a day before
// and marked as done, while the plugin's new connection read 16:25 that day and labeled it Idle.
test("a workspace seen for the first time starts from hide-workspaces' mark, the app's time", () => {
  const now = Date.parse("2026-10-24T16:44:24Z");
  const workspace = {
    id: "wks_a62be6c5ef3b54f1",
    status: "done",
    statusEnteredAt: "2026-10-24T16:25:53.365Z",
    lastUserMessageAt: "2026-10-23T11:15:07.648Z",
  };
  const marks = { wks_a62be6c5ef3b54f1: 1792754204326 };
  assert.equal(labelFor(workspace, now, none, doneSince({}, [workspace], marks), marks), "Done");
  // Not a mark from before your last message.
  const messaged = { ...workspace, lastUserMessageAt: "2026-10-24T15:00:00Z" };
  assert.equal(labelFor(messaged, now, none, doneSince({}, [messaged], marks), marks), "Idle");
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
