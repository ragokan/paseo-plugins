import test from "node:test";
import assert from "node:assert/strict";
import { startFrameLoop } from "./frames.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const ready = {
  status: "ready", reason: null, windows: [], windowId: "0x1", windowWidth: 1840, windowHeight: 1048,
  hash: "a", changed: true, image: "jpeg", mimeType: "image/jpeg", imageWidth: 920, imageHeight: 524,
};

function loop(read, overrides = {}) {
  let shown = { windowId: null, hash: null, mimeType: null };
  const frames = [];
  const errors = [];
  const stop = startFrameLoop({
    read, windowId: null, maxWidth: 920, maxHeight: 524, quality: 70, lossless: false,
    getShown: () => shown,
    forgetShown: () => { shown = { windowId: null, hash: null, mimeType: null }; },
    onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error),
    ...overrides,
  });
  return { stop, frames, errors, display: (frame) => { shown = { windowId: frame.windowId, hash: frame.hash, mimeType: frame.mimeType }; } };
}

test("frame polling uses the displayed hash, a 1500ms long poll and a minimum 30ms gap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = [];
  const running = loop(async (request) => { requests.push(request); return ready; });
  t.after(running.stop);
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].since, null);
  assert.equal(requests[0].waitMs, 0);
  assert.equal(requests[0].maxWidth, 920);
  running.display(ready);
  t.mock.timers.tick(29);
  await settle();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(requests[1].since, "a");
  assert.equal(requests[1].waitMs, 1500);
  running.stop();
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(requests.length, 2);
});

test("hiding during a pending RPC ignores its late result and never polls again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  let requests = 0;
  const running = loop(() => { requests++; return new Promise((resolve) => { finish = resolve; }); });
  running.stop();
  finish(ready);
  await settle();
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(requests, 1);
  assert.deepEqual(running.frames, []);
  assert.deepEqual(running.errors, []);
});

test("mode restarts fetch a fresh hash, ignore old responses, and wait for the new MIME to display", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let shown = { windowId: ready.windowId, hash: ready.hash, mimeType: ready.mimeType };
  let finishOld;
  const old = loop(() => new Promise((resolve) => { finishOld = resolve; }), { getShown: () => shown });
  old.stop();
  const requests = [];
  const png = { ...ready, image: "png", mimeType: "image/png" };
  const high = loop(async (request) => { requests.push(request); return png; }, {
    getShown: () => shown, maxWidth: 1920, maxHeight: 1080, quality: 95, lossless: true,
  });
  t.after(high.stop);
  await settle();
  finishOld(ready);
  await settle();
  assert.deepEqual(old.frames, []);
  assert.equal(requests[0].since, null);
  assert.equal(requests[0].lossless, true);
  assert.equal(requests[0].quality, 95);
  assert.equal(requests[0].maxWidth, 1920);
  assert.equal(requests[0].maxHeight, 1080);
  t.mock.timers.tick(30);
  await settle();
  assert.equal(requests[1].since, null);
  shown = { ...shown, mimeType: "image/png" };
  t.mock.timers.tick(30);
  await settle();
  assert.equal(requests[2].since, ready.hash);
  high.stop();
  const normalRequests = [];
  const normal = loop(async (request) => { normalRequests.push(request); return ready; }, { getShown: () => shown });
  t.after(normal.stop);
  await settle();
  assert.equal(normalRequests[0].since, null);
  assert.equal(normalRequests[0].lossless, false);
  assert.equal(normalRequests[0].quality, 70);
});

test("errors back off from 1s to 5s and a successful read resets the delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  const running = loop(async () => {
    requests++;
    if (requests === 6) return ready;
    throw new Error("Disconnected");
  });
  t.after(running.stop);
  await settle();
  assert.equal(requests, 1);
  for (const [index, delay] of [1000, 2000, 4000, 5000, 5000].entries()) {
    t.mock.timers.tick(delay - 1);
    await settle();
    assert.equal(requests, index + 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(requests, index + 2);
  }
  assert.equal(running.errors.at(-1), null);
  t.mock.timers.tick(30);
  await settle();
  assert.equal(requests, 7);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(requests, 8);
});

test("not-running and a changed default with identical pixels force a fresh image", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = [];
  const responses = [ready,
    { ...ready, status: "not-running", windowId: null, hash: null, image: null }, ready,
    { ...ready, windowId: "0x2", image: null, changed: false }, ready,
  ];
  const running = loop(async (request) => { requests.push(request); return responses.shift() ?? ready; });
  t.after(running.stop);
  await settle();
  running.display(ready);
  t.mock.timers.tick(30);
  await settle();
  assert.equal(requests[1].since, "a");
  t.mock.timers.tick(999);
  await settle();
  assert.equal(requests.length, 2);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(requests[2].since, null);
  assert.equal(requests[2].waitMs, 0);
  running.display(ready);
  t.mock.timers.tick(30);
  await settle();
  assert.equal(requests[3].since, "a");
  t.mock.timers.tick(30);
  await settle();
  assert.equal(requests[4].since, null);
});
