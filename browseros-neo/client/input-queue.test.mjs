import test from "node:test";
import assert from "node:assert/strict";
import { createInputQueue } from "./input-queue.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const success = { ok: true, error: null };
const move = (x) => ({ type: "move", x, y: 2 });
const click = { type: "click", x: 5, y: 6, button: "left", count: 1 };

test("consecutive moves coalesce without losing button transitions or window identity", async () => {
  const sent = [];
  const queue = createInputQueue(async (batch) => { sent.push(batch); return success; }, assert.fail);
  queue.push("0x1", move(1));
  queue.push("0x1", move(2));
  queue.push("0x1", { type: "down", x: 2, y: 2, button: "left" });
  queue.push("0x1", move(3));
  queue.push("0x1", move(4));
  queue.push("0x1", { type: "up", x: 4, y: 2, button: "left" });
  queue.push("0x2", move(5));
  await tick();
  assert.deepEqual(sent, [
    { windowId: "0x1", events: [move(2), { type: "down", x: 2, y: 2, button: "left" }, move(4), { type: "up", x: 4, y: 2, button: "left" }] },
    { windowId: "0x2", events: [move(5)] },
  ]);
});

test("only one RPC is in flight; queued batches stay ordered and at most 200 events", async () => {
  const sent = [];
  let finish;
  let concurrent = 0;
  let peak = 0;
  const queue = createInputQueue(async (batch) => {
    sent.push(batch);
    peak = Math.max(peak, ++concurrent);
    if (sent.length === 1) await new Promise((resolve) => { finish = resolve; });
    concurrent--;
    return success;
  }, assert.fail);
  queue.push("0x1", click);
  await tick();
  for (let index = 0; index < 401; index++) queue.push("0x1", { type: "text", text: String(index) });
  queue.push("0x2", click);
  await tick();
  assert.equal(sent.length, 1);
  finish();
  await tick();
  assert.equal(peak, 1);
  assert.deepEqual(sent.map((batch) => batch.events.length), [1, 200, 200, 1, 1]);
  assert.deepEqual(sent.slice(1, 4).flatMap((batch) => batch.events.map((event) => event.text)), Array.from({ length: 401 }, (_, index) => String(index)));
  assert.equal(sent.at(-1).windowId, "0x2");
});

test("large Unicode pastes split within the text contract limit", async () => {
  const sent = [];
  const queue = createInputQueue(async (batch) => { sent.push(batch); return success; }, assert.fail);
  const text = "a".repeat(9999) + "😀" + "b".repeat(11000);
  queue.push("0x1", { type: "text", text });
  await tick();
  const chunks = sent.flatMap((batch) => batch.events.map((event) => event.text));
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 10000 && !/[\uD800-\uDBFF]$/.test(chunk)));
});

test("failed input is reported once and never replayed", async () => {
  const errors = [];
  let calls = 0;
  const queue = createInputQueue(async () => { calls++; return { ok: false, error: "Window closed" }; }, (error) => errors.push(error));
  queue.push("0x1", click);
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(errors, ["Window closed"]);
});

test("disconnect drops queued input, sends only held-button releases after the in-flight RPC, and stays closed", async () => {
  const sent = [];
  let finish;
  const queue = createInputQueue(async (batch) => {
    sent.push(batch);
    if (sent.length === 1) await new Promise((resolve) => { finish = resolve; });
    return success;
  }, assert.fail);
  queue.push("0x1", { type: "down", x: 5, y: 6, button: "left" });
  queue.push("0x1", { type: "down", x: 5, y: 6, button: "right" });
  queue.push("0x1", move(20));
  await tick();
  queue.push("0x1", { type: "text", text: "must be dropped" });
  queue.push("0x1", move(100));
  queue.push("0x2", click);
  queue.disconnect();
  // A repeated lifecycle cleanup must not discard the scheduled releases.
  queue.disconnect();
  queue.push("0x1", { type: "text", text: "still disconnected" });
  assert.equal(sent.length, 1);
  finish();
  await tick();
  assert.deepEqual(sent[1], { windowId: "0x1", events: [
    { type: "up", x: 20, y: 2, button: "left" },
    { type: "up", x: 20, y: 2, button: "right" },
  ] });
  assert.equal(sent.length, 2);
  queue.connect();
  queue.push("0x2", click);
  await tick();
  assert.deepEqual(sent[2], { windowId: "0x2", events: [click] });
});

test("a disconnected queue sends nothing; unsent downs are discarded without a release RPC", async () => {
  const sent = [];
  const queue = createInputQueue(async (batch) => { sent.push(batch); return success; }, assert.fail, false);
  queue.push("0x1", click);
  await tick();
  assert.deepEqual(sent, []);
  queue.connect();
  queue.push("0x1", { type: "down", x: 1, y: 2, button: "left" });
  queue.disconnect();
  await tick();
  assert.deepEqual(sent, []);
});
