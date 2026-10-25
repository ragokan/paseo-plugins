import test from "node:test";
import assert from "node:assert/strict";
import {
  captureDimension, fitSize, isPasteShortcut, keyInput, mapPoint,
  mouseButton, NotchAccumulator, textChange, TouchGesture, wheelPixels,
} from "./logic.ts";

test("fit preserves the whole window and maps centered/edge positions into X11 pixels", () => {
  const remote = { width: 1840, height: 1048 };
  const drawn = fitSize({ width: 920, height: 700 }, remote);
  assert.deepEqual(drawn, { width: 920, height: 524 });
  assert.deepEqual(mapPoint({ x: 460, y: 262 }, drawn, remote), { x: 920, y: 524 });
  assert.deepEqual(mapPoint({ x: 920, y: 524 }, drawn, remote), { x: 1839, y: 1047 });
  assert.deepEqual(mapPoint({ x: -20, y: -30 }, drawn, remote), { x: 0, y: 0 });
  assert.equal(mapPoint({ x: 1, y: 1 }, { width: 0, height: 0 }, remote), null);
  const zoomed = { width: 1840, height: 1048 };
  assert.deepEqual(mapPoint({ x: 1000, y: 700 }, zoomed, remote), { x: 1000, y: 700 });
});

test("normal fitting never enlarges an equal or smaller window", () => {
  const box = { width: 1273, height: 836 };
  const smaller = { width: 1264, height: 832 };
  assert.deepEqual(fitSize(box, smaller), smaller);
  assert.deepEqual(fitSize(box, box), box);
  assert.deepEqual(fitSize({ width: 1800, height: 1200 }, { width: 800, height: 600 }), { width: 800, height: 600 });
  const downscaled = fitSize(box, { width: 1280, height: 840 });
  assert.equal(downscaled.width, 1273);
  assert.ok(downscaled.height <= box.height);
  assert.equal(fitSize({ width: 0, height: 0 }, smaller).width, 0);
});

test("1:1 drawing maps every integer pixel without rounding one pixel backwards", () => {
  const remote = { width: 1264, height: 832 };
  for (let x = 0; x < remote.width; x++) {
    assert.deepEqual(mapPoint({ x, y: 416 }, remote, remote), { x, y: 416 });
  }
});

test("native zoom may still use the original uncapped fit scale", () => {
  const zoomBase = fitSize({ width: 1600, height: 1200 }, { width: 800, height: 600 }, true);
  assert.deepEqual(zoomBase, { width: 1600, height: 1200 });
  assert.deepEqual(mapPoint({ x: 800, y: 600 }, zoomBase, { width: 800, height: 600 }), { x: 400, y: 300 });
});

test("capture sizes round and stay within the RPC limits", () => {
  assert.equal(captureDimension(32), 64);
  assert.equal(captureDimension(912.7), 913);
  assert.equal(captureDimension(12000), 8192);
});

test("wheel normalizes pixel, line and page delta modes", () => {
  assert.deepEqual(wheelPixels(10, -20, 0, 500), { x: 10, y: -20 });
  assert.deepEqual(wheelPixels(1, 3, 1, 500), { x: 16, y: 48 });
  assert.deepEqual(wheelPixels(0, 1, 2, 500), { x: 0, y: 500 });
});

test("wheel retains small trackpad deltas on both axes and changes direction", () => {
  const wheel = new NotchAccumulator();
  assert.deepEqual(wheel.take(30, -20), { dx: 0, dy: 0 });
  assert.deepEqual(wheel.take(30, -40), { dx: 1, dy: -1 });
  assert.deepEqual(wheel.take(-90, 90), { dx: -1, dy: 1 });
  assert.deepEqual(wheel.take(30, -30), { dx: 0, dy: 0 });
  const finger = new NotchAccumulator();
  assert.deepEqual(finger.take(0, 39, 40), { dx: 0, dy: 0 });
  assert.deepEqual(finger.take(0, 1, 40), { dx: 0, dy: 1 });
  assert.deepEqual(wheel.take(6000, -6000), { dx: 50, dy: -50 });
});

test("a touch tap tolerates less than 10px movement and clicks the release point once", () => {
  const touch = new TouchGesture({ x: 100, y: 100 }, 0);
  assert.equal(touch.move({ x: 104, y: 103 }), null);
  assert.equal(touch.hold(499), null);
  assert.deepEqual(touch.end({ x: 109, y: 100 }, 499), { type: "click", point: { x: 109, y: 100 }, button: "left" });
  assert.equal(touch.end({ x: 109, y: 100 }, 500), null);
  assert.equal(touch.hold(1000), null);
});

test("a touch hold right clicks at 500ms and never also taps or scrolls", () => {
  const touch = new TouchGesture({ x: 100, y: 100 }, 100);
  touch.move({ x: 102, y: 100 });
  assert.equal(touch.hold(599), null);
  assert.deepEqual(touch.hold(600), { type: "click", point: { x: 102, y: 100 }, button: "right" });
  assert.equal(touch.hold(900), null);
  assert.equal(touch.move({ x: 100, y: 20 }), null);
  assert.equal(touch.end({ x: 100, y: 20 }, 1000), null);
  const delayedTimer = new TouchGesture({ x: 0, y: 0 }, 0);
  assert.deepEqual(delayedTimer.end({ x: 0, y: 0 }, 500), { type: "click", point: { x: 0, y: 0 }, button: "right" });
});

test("touch drags retain fractional travel and scroll naturally at 40px per notch", () => {
  const touch = new TouchGesture({ x: 100, y: 100 }, 0);
  assert.equal(touch.move({ x: 100, y: 90 }), null);
  assert.equal(touch.isDragging, true);
  assert.equal(touch.move({ x: 81, y: 61 }), null);
  assert.deepEqual(touch.move({ x: 60, y: 60 }), { type: "scroll", point: { x: 100, y: 100 }, dx: 1, dy: 1 });
  assert.equal(touch.hold(1000), null);
  assert.deepEqual(touch.move({ x: 100, y: 100 }), { type: "scroll", point: { x: 100, y: 100 }, dx: -1, dy: -1 });
  assert.equal(touch.end({ x: 100, y: 100 }, 1500), null);
});

test("a touch release crossing the drag threshold cannot become a click", () => {
  const smallDrag = new TouchGesture({ x: 0, y: 0 }, 0);
  assert.equal(smallDrag.end({ x: 10, y: 0 }, 100), null);
  const jump = new TouchGesture({ x: 100, y: 100 }, 0);
  assert.deepEqual(jump.end({ x: 20, y: 100 }, 100), { type: "scroll", point: { x: 100, y: 100 }, dx: 2, dy: 0 });
});

const key = (name, rest = {}) => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...rest });

test("printable keys become text, while shortcuts and navigation become key presses", () => {
  assert.deepEqual(keyInput(key("A", { shiftKey: true })), { type: "text", text: "A" });
  assert.deepEqual(keyInput(key("😀")), { type: "text", text: "😀" });
  assert.deepEqual(keyInput(key("ArrowLeft", { shiftKey: true })), { type: "key", key: "ArrowLeft", modifiers: ["shift"] });
  assert.deepEqual(keyInput(key("Enter")), { type: "key", key: "Enter", modifiers: [] });
  assert.equal(keyInput(key("Dead")), null);
  assert.equal(keyInput(key("a", { isComposing: true })), null);
});

test("Command maps to ctrl once and paste waits for clipboard text", () => {
  for (const name of ["l", "t", "w", "c", "a"]) {
    assert.deepEqual(keyInput(key(name, { metaKey: true })), { type: "key", key: name, modifiers: ["ctrl"] });
  }
  assert.deepEqual(keyInput(key("L", { metaKey: true, ctrlKey: true, shiftKey: true, altKey: true })), {
    type: "key", key: "L", modifiers: ["ctrl", "shift", "alt"],
  });
  assert.equal(keyInput(key("v", { metaKey: true })), null);
  assert.equal(keyInput(key("V", { ctrlKey: true, shiftKey: true })), null);
  assert.equal(isPasteShortcut(key("v")), false);
  assert.equal(isPasteShortcut(key("v", { ctrlKey: true })), true);
  assert.deepEqual([0, 1, 2, 3].map(mouseButton), ["left", "middle", "right", null]);
});

test("text input diffs handle append, deletion, replacement and Unicode", () => {
  assert.deepEqual(textChange("abc", "abcd"), { inserted: "d", removed: 0 });
  assert.deepEqual(textChange("abc", "ab"), { inserted: "", removed: 1 });
  assert.deepEqual(textChange("abc", ""), { inserted: "", removed: 3 });
  assert.deepEqual(textChange("abc", "axc"), { inserted: "x", removed: 1 });
  assert.deepEqual(textChange("😀", "😁"), { inserted: "😁", removed: 1 });
});
