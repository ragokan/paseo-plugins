import test from "node:test";
import assert from "node:assert/strict";
import { connectionActive, isReleaseInput, rememberedConnection, rememberConnection } from "./connection.ts";

test("RPCs and input bindings require an explicit connection, visibility and foreground", () => {
  for (const connected of [false, true]) {
    for (const visible of [false, true]) {
      for (const foreground of [false, true]) {
        assert.equal(connectionActive({ connected, visible, foreground }), connected && visible && foreground);
      }
    }
  }
  assert.equal(isReleaseInput([]), false);
  assert.equal(isReleaseInput([{ type: "key", key: "a", modifiers: [] }]), false);
  assert.equal(isReleaseInput([{ type: "up", x: 1, y: 2, button: "left" }]), true);
  assert.equal(isReleaseInput([{ type: "up", x: 1, y: 2, button: "left" }, { type: "text", text: "a" }]), false);
});

test("each host starts disconnected and remembers explicit choices only for the session", async () => {
  const host = "connection-test-host";
  const other = "connection-test-other-host";
  try {
    assert.equal(rememberedConnection(host), false);
    rememberConnection(host, true);
    const reopened = await import("./connection.ts?reopened");
    assert.equal(reopened.rememberedConnection(host), true);
    assert.equal(reopened.rememberedConnection(other), false);
    rememberConnection(other, true);
    rememberConnection(host, false);
    assert.equal(reopened.rememberedConnection(host), false);
    assert.equal(reopened.rememberedConnection(other), true);
  } finally {
    rememberConnection(host, false);
    rememberConnection(other, false);
  }
});
