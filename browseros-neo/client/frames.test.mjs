import test from "node:test";
import assert from "node:assert/strict";
import { startFrameLoop } from "./frames.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const ready = {
  status: "ready", reason: null, windows: [], windowId: "0x1", windowWidth: 1840, windowHeight: 1048,
  hash: "a", changed: true, image: "jpeg", mimeType: "image/jpeg", imageWidth: 920, imageHeight: 524,
};

test("request starts are capped at 30 per second", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const trace = [];
  const running = loop(async (request) => { trace.push({ at: Date.now(), since: request.since }); return ready; });
  t.after(running.stop);
  await settle();
  t.mock.timers.tick(33);
  await settle();
  assert.equal(trace.length, 1);
  await advance(t, 1000);
  assert.ok(trace.length <= 31);
  assert.ok(trace.length >= 29);
  assert.ok(trace.every((entry, index) => index === 0 || entry.at - trace[index - 1].at >= 1000 / 30));
});

test("since advances on receipt even when no frame has displayed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const requests = [];
  const motion = { ...ready, hash: "b:motion", image: "jpeg-b" };
  const still = { ...motion, hash: "b:still", image: "png-b", mimeType: "image/png" };
  const responses = [ready, motion, still];
  const running = loop(async (request) => { requests.push(request); return responses.shift() ?? { ...still, image: null, changed: false }; });
  t.after(running.stop);
  await settle();
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(34);
    await settle();
  }
  assert.deepEqual(requests.map((request) => request.since), [null, ready.hash, motion.hash, still.hash]);
  assert.deepEqual(running.frames.map((frame) => frame.hash), [ready.hash, motion.hash, still.hash, still.hash]);
});

function loop(read, overrides = {}) {
  const frames = [];
  const errors = [];
  const stop = startFrameLoop({
    read, windowId: null, maxWidth: 920, maxHeight: 524, quality: 80, lossless: false,
    onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error),
    ...overrides,
  });
  return { stop, frames, errors };
}

async function advance(t, milliseconds) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed++) {
    t.mock.timers.tick(1);
    await settle();
  }
}

for (const [mode, lossless, mebibytes] of [["normal", false, 3], ["Quality", true, 5]]) {
  for (const kibibytes of [220, 300]) {
    test(`${mode} mode converges to ${mebibytes} MiB/s for ${kibibytes} KiB base64 frames`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const frame = { ...ready, image: "x".repeat(kibibytes * 1024) };
      const wireBytes = frame.image.length + 1024;
      const budget = mebibytes * 1024 * 1024;
      let bytes = 0;
      const running = loop(async () => { bytes += wireBytes; return frame; }, { lossless });
      t.after(running.stop);
      await settle();
      await advance(t, 10000);
      const baseline = bytes;
      await advance(t, 20000);
      const rate = (bytes - baseline) / 20;
      t.diagnostic(`steady wire rate: ${(rate / 1024 / 1024).toFixed(3)} MiB/s`);
      assert.ok(Math.abs(rate / budget - 1) < 0.01, `rate ${rate} differs from budget ${budget}`);
      assert.ok(bytes <= budget * 30 + budget / 2 + wireBytes, "only a half-second burst plus the last frame may exceed the budget");
    });
  }
}

test("wire pacing counts the base64 characters plus 1 KiB and starts with a half-second bucket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const budget = 3 * 1024 * 1024;
  const frame = { ...ready, image: "x".repeat(Math.floor(budget * 0.6)) };
  const trace = [];
  const running = loop(async () => { trace.push(Date.now()); return frame; });
  t.after(running.stop);
  await settle();
  const debtWait = Math.ceil((frame.image.length + 1024 - budget / 2) / budget * 1000);
  t.mock.timers.tick(debtWait - 1);
  await settle();
  assert.deepEqual(trace, [0]);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(trace, [0, debtWait]);
});

test("an unchanged long poll replenishes the bucket and the next burst starts immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const budget = 3 * 1024 * 1024;
  const frame = { ...ready, image: "x".repeat(budget) };
  const trace = [];
  let finishPoll;
  const running = loop((request) => {
    trace.push({ at: Date.now(), since: request.since, waitMs: request.waitMs });
    return trace.length === 2 ? new Promise((resolve) => { finishPoll = resolve; }) : Promise.resolve(frame);
  });
  t.after(running.stop);
  await settle();
  const debtWait = Math.ceil((budget / 2 + 1024) / budget * 1000);
  t.mock.timers.tick(debtWait);
  await settle();
  assert.equal(trace.length, 2);
  assert.equal(trace[1].since, ready.hash);
  assert.equal(trace[1].waitMs, 1500);
  t.mock.timers.tick(1500);
  finishPoll({ ...frame, changed: false, image: null });
  await settle();
  t.mock.timers.tick(0);
  await settle();
  assert.equal(trace[2].at, debtWait + 1500);
  assert.equal(trace[2].since, ready.hash);
});

for (const responseTime of [23, 60]) {
  test(`a ${responseTime} ms response has no extra wait beyond the request-start cap`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const trace = [];
    const running = loop(() => {
      trace.push(Date.now());
      return new Promise((resolve) => { setTimeout(() => resolve(ready), responseTime); });
    });
    t.after(running.stop);
    await settle();
    await advance(t, Math.max(34, responseTime));
    assert.deepEqual(trace, [0, Math.max(34, responseTime)]);
  });
}

for (const imageLength of [4, 3 * 1024 * 1024]) {
  test(`stopping cancels a ${imageLength === 4 ? "request-rate" : "byte-budget"} pacing wait`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const clear = t.mock.method(globalThis, "clearTimeout");
    let requests = 0;
    const running = loop(async () => { requests++; return { ...ready, image: "x".repeat(imageLength) }; });
    t.after(running.stop);
    await settle();
    t.mock.timers.tick(10);
    running.stop();
    assert.equal(clear.mock.callCount(), 1);
    await settle();
    t.mock.timers.tick(10000);
    await settle();
    assert.equal(requests, 1);
    assert.equal(running.frames.length, 1);
  });
}

test("unchanged responses keep the received id and long poll, with only request-start pacing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const requests = [];
  const running = loop(async (request) => {
    requests.push(request);
    return requests.length === 1 ? ready : { ...ready, changed: false, image: null };
  });
  t.after(running.stop);
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].since, null);
  assert.equal(requests[0].waitMs, 0);
  assert.equal(requests[0].maxWidth, 920);
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests[1].since, "a");
  assert.equal(requests[1].waitMs, 1500);
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests[2].since, ready.hash);
  running.stop();
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(requests.length, 3);
});

test("hiding during a pending RPC ignores its late result and never polls again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
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

test("mode restarts fetch a fresh id, ignore old responses, and track refinement before display", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let finishOld;
  const old = loop(() => new Promise((resolve) => { finishOld = resolve; }));
  old.stop();
  const requests = [];
  const png = { ...ready, hash: "a:still", image: "png", mimeType: "image/png" };
  const high = loop(async (request) => { requests.push(request); return png; }, {
    maxWidth: 920, maxHeight: 524, quality: 92, lossless: true,
  });
  t.after(high.stop);
  await settle();
  finishOld(ready);
  await settle();
  assert.deepEqual(old.frames, []);
  assert.equal(requests[0].since, null);
  assert.equal(requests[0].lossless, true);
  assert.equal(requests[0].quality, 92);
  assert.equal(requests[0].maxWidth, 920);
  assert.equal(requests[0].maxHeight, 524);
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests[1].since, png.hash);
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests[2].since, png.hash);
  high.stop();
  const normalRequests = [];
  const normal = loop(async (request) => { normalRequests.push(request); return ready; });
  t.after(normal.stop);
  await settle();
  assert.equal(normalRequests[0].since, null);
  assert.equal(normalRequests[0].lossless, false);
  assert.equal(normalRequests[0].quality, 80);
  assert.equal(normalRequests[0].maxWidth, requests[0].maxWidth);
  assert.equal(normalRequests[0].maxHeight, requests[0].maxHeight);
});

test("errors back off from 1s to 5s and a successful read resets the delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
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
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests, 7);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(requests, 8);
});

test("not-running waits 1s and clears the cursor; every ready response advances it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const requests = [];
  const responses = [ready,
    { ...ready, status: "not-running", windowId: null, hash: null, image: null }, ready,
    { ...ready, windowId: "0x2", image: null, changed: false }, ready,
  ];
  const running = loop(async (request) => { requests.push(request); return responses.shift() ?? ready; });
  t.after(running.stop);
  await settle();
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests[1].since, "a");
  t.mock.timers.tick(999);
  await settle();
  assert.equal(requests.length, 2);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(requests[2].since, null);
  assert.equal(requests[2].waitMs, 0);
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests[3].since, "a");
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests[4].since, ready.hash);
});

test("unsupported waits 1.5s and failed reads retain the last received id", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const requests = [];
  const running = loop(async (request) => {
    requests.push(request);
    if (requests.length === 2) throw new Error("Temporary failure");
    return requests.length === 3 ? { ...ready, status: "unsupported", hash: null, image: null } : ready;
  });
  t.after(running.stop);
  await settle();
  t.mock.timers.tick(34);
  await settle();
  assert.equal(requests[1].since, ready.hash);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(requests[2].since, ready.hash);
  t.mock.timers.tick(1499);
  await settle();
  assert.equal(requests.length, 3);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(requests[3].since, null);
});
