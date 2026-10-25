import test from "node:test";
import assert from "node:assert/strict";
import { pinWindow, rememberedWindow, rememberWindow } from "./selection.ts";

const frame = (id, ids = [id]) => ({ status: "ready", windowId: id, windows: ids.map((id) => ({ id })) });

test("the first ready frame pins its window and later default changes keep the pin", () => {
  assert.equal(pinWindow(null, { status: "not-running", windowId: null, windows: [] }), null);
  const first = pinWindow(null, frame("0x1", ["0x1", "0x2"]));
  assert.equal(first, "0x1");
  assert.equal(pinWindow(first, frame("0x2", ["0x2", "0x1"])), "0x1");
  assert.equal(pinWindow("0x2", frame("0x1", ["0x1", "0x2"])), "0x2");
});

test("missing or stale remembered windows fall back to the returned default", () => {
  assert.equal(pinWindow("0x9", frame("0x2", ["0x2", "0x3"])), "0x2");
  assert.equal(pinWindow("0x1", { status: "unsupported", windowId: null, windows: [] }), "0x1");
  assert.equal(pinWindow("0x1", { status: "not-running", windowId: null, windows: [] }), "0x1");
  assert.equal(pinWindow("0x1", frame("0x3")), "0x3");
});

test("window choices live in session memory per host, shared across module copies", async () => {
  const host = "selection-test-host";
  const other = "selection-test-other-host";
  try {
    assert.equal(rememberedWindow(host), null);
    rememberWindow(host, "0x1");
    rememberWindow(other, "0x2");
    const reopened = await import("./selection.ts?reopened");
    assert.equal(reopened.rememberedWindow(host), "0x1");
    assert.equal(reopened.rememberedWindow(other), "0x2");
    rememberWindow(host, "0x3");
    assert.equal(reopened.rememberedWindow(host), "0x3");
    rememberWindow(host, null);
    assert.equal(reopened.rememberedWindow(host), null);
  } finally {
    rememberWindow(host, null);
    rememberWindow(other, null);
  }
});
