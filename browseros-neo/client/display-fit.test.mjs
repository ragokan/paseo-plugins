import test from "node:test";
import assert from "node:assert/strict";
import { createDisplayFitter, displaySize } from "./display-fit.ts";

const box = { width: 390.4, height: 844.2 };

test("display fitting rounds logical pixels and respects contract bounds", () => {
  assert.deepEqual(displaySize(box), { width: 390, height: 844 });
  assert.deepEqual(displaySize({ width: 50, height: 9000 }), { width: 100, height: 8192 });
  for (const invalid of [{ width: 0, height: 500 }, { width: 500, height: -1 }, { width: NaN, height: Infinity }]) {
    assert.equal(displaySize(invalid), null);
  }
});

test("repeated box updates do not fit again or postpone a pending resize", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sent = [];
  const fitter = createDisplayFitter(async (size) => { sent.push(size); return { ok: true }; });
  t.after(fitter.pause);
  fitter.update(true, box);
  fitter.update(true, box);
  assert.deepEqual(sent, [{ width: 390, height: 844 }]);
  const rotated = { width: 844, height: 390 };
  fitter.update(true, rotated);
  t.mock.timers.tick(499);
  fitter.update(true, rotated);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(sent.at(-1), { width: 844, height: 390 });
  assert.equal(sent.length, 2);
});

test("a visible measured screen fits immediately, resuming takes ownership again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sent = [];
  const fitter = createDisplayFitter(async (size) => { sent.push(size); return { ok: true }; });
  t.after(fitter.pause);
  fitter.update(false, box);
  fitter.interact();
  fitter.update(true, { width: 0, height: 0 });
  assert.deepEqual(sent, []);
  fitter.update(true, box);
  fitter.update(true, box);
  assert.deepEqual(sent, [{ width: 390, height: 844 }]);
  fitter.update(false, box);
  fitter.update(true, box);
  assert.equal(sent.length, 2);
});

test("resize debounce uses the latest box and equal rounded sizes do not restart it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sent = [];
  const fitter = createDisplayFitter(async (size) => { sent.push(size); return { ok: true }; });
  t.after(fitter.pause);
  fitter.update(true, box);
  fitter.update(true, { width: 800, height: 600 });
  t.mock.timers.tick(400);
  fitter.update(true, { width: 900.1, height: 600 });
  t.mock.timers.tick(400);
  fitter.update(true, { width: 900.3, height: 600 });
  t.mock.timers.tick(99);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(sent[1], { width: 900, height: 600 });
  fitter.update(true, { width: 1000, height: 700 });
  fitter.update(false, box);
  t.mock.timers.tick(1000);
  fitter.interact();
  assert.equal(sent.length, 2);
});

test("first interaction after 3s fits once, using the latest size and cancelling a pending resize", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sent = [];
  const fitter = createDisplayFitter(async (size) => { sent.push(size); return { ok: true }; });
  t.after(fitter.pause);
  fitter.update(true, box);
  t.mock.timers.tick(2999);
  fitter.interact();
  assert.equal(sent.length, 1);
  fitter.update(true, { width: 844, height: 390 });
  t.mock.timers.tick(1);
  fitter.interact();
  fitter.interact();
  assert.deepEqual(sent[1], { width: 844, height: 390 });
  t.mock.timers.tick(500);
  assert.equal(sent.length, 2);
  t.mock.timers.tick(2500);
  fitter.interact();
  assert.equal(sent.length, 3);
  fitter.pause();
  t.mock.timers.tick(3000);
  fitter.interact();
  assert.equal(sent.length, 3);
});

test("declined and failed fitting stays quiet and still throttles interactions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0;
  const fitter = createDisplayFitter(() => {
    calls++;
    if (calls === 1) return Promise.resolve({ ok: false });
    if (calls === 2) return Promise.reject(new Error("Unavailable"));
    throw new Error("Disconnected");
  });
  t.after(fitter.pause);
  fitter.update(true, box);
  for (let index = 0; index < 2; index++) {
    t.mock.timers.tick(3000);
    fitter.interact();
    fitter.interact();
    await Promise.resolve();
  }
  assert.equal(calls, 3);
});
