import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createInputQueue } from "./input-queue.ts";

// Keep Node out of React Native's renderer; exercise the real web adapter.
const shim = "data:text/javascript," + encodeURIComponent('export const Platform = { OS: "web" };');
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "react-native" ? { url: shim, shortCircuit: true } : next(specifier, context);
  },
});
const { Platform } = await import(shim);
const { bindViewer, watchShown } = await import("./web.ts");
hooks.deregister();

class Source {
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, properties = {}) {
    const event = {
      clientX: 470, clientY: 282, button: 0, pointerId: 1,
      ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  count() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
}

class Surface extends Source {
  style = { touchAction: "auto", userSelect: "auto", outline: "initial" };
  attributes = new Map();
  captures = new Set();
  shown = true;
  getClientRects() { return { length: this.shown ? 1 : 0 }; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 920, height: 524 }; }
  contains(node) { return node === this; }
  focus() { this.focused = true; }
  setPointerCapture(id) { this.captures.add(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

function environment(options = {}) {
  Platform.OS = "web";
  const page = new Source();
  const doc = new Source();
  doc.hidden = false;
  globalThis["window"] = page;
  globalThis["document"] = doc;
  const node = new Surface();
  const sent = [];
  const focus = [];
  const stop = bindViewer(node, { remote: { width: 1840, height: 1048 }, send: (event) => sent.push(event), onFocus: (value) => focus.push(value), ...options });
  return { page, doc, node, sent, focus, stop };
}

afterEach(() => {
  delete globalThis["window"];
  delete globalThis["document"];
  delete globalThis["ResizeObserver"];
});

test("web drag scales from the image rect, captures the pointer and releases outside", () => {
  const { page, node, sent, focus, stop } = environment();
  node.dispatch("pointerdown");
  assert.equal(node.focused, true);
  assert.equal(node.captures.has(1), true);
  node.dispatch("pointermove", { clientX: 2000, clientY: -100 });
  page.dispatch("pointerup", { clientX: 2000, clientY: -100 });
  assert.deepEqual(sent, [
    { type: "move", x: 920, y: 524 },
    { type: "down", x: 920, y: 524, button: "left" },
    { type: "move", x: 1839, y: 0 },
    { type: "up", x: 1839, y: 0, button: "left" },
  ]);
  assert.deepEqual(focus, [true]);
  assert.equal(node.captures.size, 0);
  stop();
});

test("resized displayed geometry remaps a held pointer without losing focus", () => {
  let remote = { width: 1840, height: 1048 };
  const { page, node, sent, focus, stop } = environment({ remote: () => remote });
  node.dispatch("pointerdown");
  remote = { width: 844, height: 390 };
  node.getBoundingClientRect = () => ({ left: 10, top: 20, width: 920, height: 460 });
  page.dispatch("pointerup", { clientX: 470, clientY: 250 });
  assert.deepEqual(sent[1], { type: "down", x: 920, y: 524, button: "left" });
  assert.deepEqual(sent.at(-1), { type: "up", x: 422, y: 195, button: "left" });
  assert.deepEqual(focus, [true]);
  stop();
});

test("interaction ownership is requested on accepted starts and keys, never hover or extra fingers", () => {
  let calls = 0;
  const { page, doc, node, stop } = environment({ onInteract: () => calls++ });
  node.dispatch("pointermove");
  assert.equal(calls, 0);
  node.dispatch("pointerdown", { pointerType: "touch" });
  node.dispatch("pointerdown", { pointerType: "touch", pointerId: 2, isPrimary: false });
  assert.equal(calls, 1);
  page.dispatch("pointerup", { pointerType: "touch" });
  page.dispatch("keydown", { key: "a" });
  assert.equal(calls, 2);
  page.dispatch("keydown", { key: "v", ctrlKey: true });
  assert.equal(calls, 3);
  doc.dispatch("focusin", { target: {} });
  page.dispatch("keydown", { key: "a" });
  assert.equal(calls, 3);
  node.dispatch("pointerdown");
  assert.equal(calls, 4);
  stop();
});

test("keys are captured only while focused, Command maps to ctrl and paste sends clipboard text", () => {
  const { page, doc, node, sent, focus, stop } = environment();
  assert.equal(page.dispatch("keydown", { key: "a" }).prevented, false);
  node.dispatch("pointerdown");
  page.dispatch("pointerup");
  sent.length = 0;
  assert.equal(page.dispatch("keydown", { key: "A", shiftKey: true }).prevented, true);
  page.dispatch("keydown", { key: "l", metaKey: true });
  const pasteKey = page.dispatch("keydown", { key: "v", metaKey: true });
  assert.equal(pasteKey.prevented, false);
  assert.equal(pasteKey.stopped, true);
  assert.equal(page.dispatch("paste", { clipboardData: { getData: () => "hello\nworld" } }).prevented, true);
  assert.deepEqual(sent, [
    { type: "text", text: "A" },
    { type: "key", key: "l", modifiers: ["ctrl"] },
    { type: "text", text: "hello\nworld" },
  ]);
  doc.dispatch("pointerdown", { target: {} });
  assert.deepEqual(focus, [true, false]);
  assert.equal(page.dispatch("keydown", { key: "b" }).prevented, false);
  stop();
  assert.equal(node.count() + page.count() + doc.count(), 0);
});

test("web wheel retains fractional trackpad travel and suppresses local scrolling", () => {
  const { node, sent, stop } = environment();
  assert.equal(node.dispatch("wheel", { deltaX: 20, deltaY: -20, deltaMode: 0 }).prevented, true);
  assert.equal(sent.length, 0);
  node.dispatch("wheel", { deltaX: 40, deltaY: -40, deltaMode: 0 });
  assert.deepEqual(sent, [{ type: "scroll", x: 920, y: 524, dx: 1, dy: -1 }]);
  assert.equal(node.dispatch("contextmenu").prevented, true);
  stop();
});

test("touch and pen taps send one left click at release without mouse events", () => {
  for (const pointerType of ["touch", "pen"]) {
    const { page, node, sent, stop } = environment();
    node.dispatch("pointerdown", { pointerType });
    assert.deepEqual(sent, []);
    node.dispatch("pointermove", { pointerType, clientX: 474, clientY: 285 });
    page.dispatch("pointerup", { pointerType, clientX: 474, clientY: 285 });
    assert.deepEqual(sent, [{ type: "click", x: 928, y: 530, button: "left", count: 1 }]);
    assert.equal(node.captures.size, 0);
    stop();
  }
});

test("touch holds right click once, extra fingers cannot cancel the primary pointer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { page, doc, node, sent, stop } = environment();
  node.dispatch("pointerdown", { pointerType: "touch" });
  doc.dispatch("pointerdown", { pointerType: "touch", pointerId: 2, isPrimary: false, target: {} });
  node.dispatch("pointerdown", { pointerType: "touch", pointerId: 2, isPrimary: false });
  node.dispatch("pointermove", { pointerType: "touch", pointerId: 2, clientY: 100 });
  node.dispatch("pointercancel", { pointerType: "touch", pointerId: 2 });
  t.mock.timers.tick(499);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(1);
  assert.deepEqual(sent, [{ type: "click", x: 920, y: 524, button: "right", count: 1 }]);
  page.dispatch("pointerup", { pointerType: "touch", pointerId: 2 });
  page.dispatch("pointerup", { pointerType: "touch" });
  assert.equal(sent.length, 1);
  stop();
});

test("touch drags scroll naturally in both axes and never click or hover", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { page, node, sent, stop } = environment();
  node.dispatch("pointermove", { pointerType: "touch" });
  node.dispatch("pointerdown", { pointerType: "touch" });
  node.dispatch("pointermove", { pointerType: "touch", clientX: 451, clientY: 263 });
  assert.deepEqual(sent, []);
  node.dispatch("pointermove", { pointerType: "touch", clientX: 430, clientY: 242 });
  t.mock.timers.tick(500);
  node.dispatch("pointermove", { pointerType: "touch", clientX: 390, clientY: 202 });
  page.dispatch("pointerup", { pointerType: "touch", clientX: 390, clientY: 202 });
  assert.deepEqual(sent, [
    { type: "scroll", x: 920, y: 524, dx: 1, dy: 1 },
    { type: "scroll", x: 920, y: 524, dx: 1, dy: 1 },
  ]);
  stop();
});

test("a cancelled or hidden touch cannot produce a delayed right click", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const cancel of ["pointercancel", "lostpointercapture", "unmount"]) {
    const { node, sent, stop } = environment();
    node.dispatch("pointerdown", { pointerType: "touch" });
    if (cancel === "unmount") stop();
    else node.dispatch(cancel, { pointerType: "touch" });
    t.mock.timers.tick(1000);
    assert.deepEqual(sent, []);
    stop();
  }
});

test("TextInput focus leaves its printable and soft keyboard events uncaptured", () => {
  const { page, doc, node, sent, focus, stop } = environment();
  node.dispatch("pointerdown");
  page.dispatch("pointerup");
  sent.length = 0;
  for (const key of ["Unidentified", "Process"]) {
    const event = page.dispatch("keydown", { key });
    assert.equal(event.prevented, false);
    assert.equal(event.stopped, false);
  }
  // TextInput autoFocus can precede a tap, so also cover a programmatic focus.
  doc.dispatch("focusin", { target: {} });
  assert.deepEqual(focus, [true, false]);
  for (const key of ["a", "Backspace", "Enter", "Unidentified", "Process"]) {
    const event = page.dispatch("keydown", { key });
    assert.equal(event.prevented, false);
    assert.equal(event.stopped, false);
  }
  page.dispatch("compositionend", { data: "a" });
  page.dispatch("paste", { clipboardData: { getData: () => "pasted" } });
  assert.deepEqual(sent, []);
  stop();
});

test("hiding/unmounting releases held buttons and restores the surface", () => {
  const { node, sent, focus, stop } = environment();
  node.dispatch("pointerdown", { button: 2 });
  stop();
  assert.deepEqual(sent.at(-1), { type: "up", x: 920, y: 524, button: "right" });
  assert.deepEqual(focus, [true, false]);
  assert.equal(node.getAttribute("tabindex"), null);
  assert.equal(node.style.touchAction, "auto");
  const count = sent.length;
  node.dispatch("pointermove");
  assert.equal(sent.length, count);
});

test("disconnect closes the real web adapter, drops unsent keys and releases a sent mouse down", async () => {
  const sent = [];
  let finish;
  const queue = createInputQueue(async (batch) => {
    sent.push(batch);
    if (sent.length === 1) await new Promise((resolve) => { finish = resolve; });
    return { ok: true, error: null };
  }, assert.fail);
  const { page, doc, node, stop } = environment({ send: (event) => queue.push("0x1", event) });
  node.dispatch("pointerdown");
  await new Promise((resolve) => setImmediate(resolve));
  page.dispatch("keydown", { key: "a" });
  queue.disconnect();
  stop();
  assert.equal(node.count() + page.count() + doc.count(), 0);
  assert.equal(page.dispatch("keydown", { key: "b" }).prevented, false);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { windowId: "0x1", events: [{ type: "up", x: 920, y: 524, button: "left" }] });
});

test("visibility follows display:none and background tabs and disconnects cleanly", () => {
  const { doc, node, stop } = environment();
  let check;
  let disconnected = false;
  globalThis["ResizeObserver"] = class {
    constructor(callback) { check = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  const states = [];
  const unwatch = watchShown(node, (shown) => states.push(shown));
  node.shown = false;
  check();
  node.shown = true;
  check();
  doc.hidden = true;
  doc.dispatch("visibilitychange");
  assert.deepEqual(states, [true, false, true, false]);
  unwatch();
  assert.equal(disconnected, true);
  assert.equal(doc.listeners.get("visibilitychange").size, 0);
  stop();
});

test("web exports safely do nothing on iOS and Android without DOM globals", () => {
  for (const platform of ["ios", "android"]) {
    Platform.OS = platform;
    const changed = [];
    const stop = bindViewer(null, { remote: { width: 1, height: 1 }, send: () => assert.fail(), onFocus: () => assert.fail() });
    const unwatch = watchShown(null, (value) => changed.push(value));
    stop();
    unwatch();
    assert.deepEqual(changed, []);
  }
});
