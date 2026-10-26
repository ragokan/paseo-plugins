import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MacHelperCache, preparing } from "./macos-helper.ts";
import { DesktopHelper } from "./helper.ts";
import { macHelperSource } from "./macos-source.ts";

function replace(source, start, end, body) {
  assert.ok(source.includes(start) && source.includes(end));
  return source.slice(0, source.indexOf(start)) + body + source.slice(source.indexOf(end, source.indexOf(start)));
}
test("native input distinguishes hover, intentional activation, dragging and cleanup releases", {
  skip: process.platform !== "darwin", timeout: 180000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "browseros-mac-input-"));
  let source = macHelperSource.replace("import Darwin", `import Darwin
var fixtureFocused = false
var fixtureFocusID: CGWindowID = 42
var fixtureMinimized = false
var fixtureActivations = 0
var fixtureRaises = 0
var fixturePosts: [[String: Any]] = []
func fixtureSetAttribute(_ element: AXUIElement, _ key: CFString, _ value: CFTypeRef) -> AXError {
    if key as String == kAXMinimizedAttribute { fixtureMinimized = false }
    return .success
}
func fixtureAction(_ element: AXUIElement, _ action: CFString) -> AXError { fixtureRaises += 1; return .success }
extension CGEvent {
    func fixturePost() { fixturePosts.append(["type": Int(type.rawValue), "x": Int(location.x), "y": Int(location.y)]) }
}
`);
  source = source.replaceAll(".post(tap: .cghidEventTap)", ".fixturePost()");
  assert.ok(!source.includes(".post("), "The native fixture must never post a real event");
  const activation = "target.app.activate(options: [.activateIgnoringOtherApps])";
  assert.ok(source.includes(activation));
  source = source.replace(activation, "fixtureActivations += 1; fixtureFocused = true; fixtureFocusID = target.id");
  source = source.replaceAll("AXUIElementSetAttributeValue", "fixtureSetAttribute").replaceAll("AXUIElementPerformAction", "fixtureAction");
  source = replace(source, "func axFrame(", "func setFrame(", "func axFrame(_ element: AXUIElement) -> CGRect? { CGRect(x: 100, y: 200, width: 1200, height: 900) }\n");
  source = replace(source, "func matchingAX(", "// Callbacks never", "func matchingAX(_ target: BrowserWindow, requireUnique: Bool = true) -> AXUIElement? { AXUIElementCreateApplication(getpid()) }\n");
  source = replace(source, "    private func permissions()", "    func windows()", "    private func permissions() -> String? { nil }\n");
  source = replace(source, "    func windows()", "    private func selected(", `    func windows() -> [BrowserWindow] {
        [42, 43].map { BrowserWindow(id: CGWindowID($0), app: NSRunningApplication.current, title: "Input fixture", frame: CGRect(x: 100, y: 200, width: 1200, height: 900), minimized: fixtureMinimized, focused: fixtureFocused && fixtureFocusID == CGWindowID($0)) }
    }
`);
  source = replace(source, "    private func focused(", "    private func activate(", "    private func focused(_ target: BrowserWindow, _ ax: AXUIElement) -> Bool { fixtureFocused && fixtureFocusID == target.id }\n");
  source = source.replace('        if method == "frame"', `        if method == "fixture-focus" { fixtureFocused = params["value"] as? Bool ?? false; if let value = params["minimized"] as? Bool { fixtureMinimized = value }; return ["ok": true] }
        if method == "fixture-minimized" { return ["value": fixtureMinimized] }
        if method == "fixture-state" { return ["activations": fixtureActivations, "raises": fixtureRaises, "posts": fixturePosts, "buttons": heldButtons.count, "keys": heldKeys.count] }
        if method == "frame"`);
  const cache = new MacHelperCache({ root, source }); let helper;
  try {
    let state;
    do { state = cache.prepare(); if (state.reason === preparing) await new Promise(resolve => setTimeout(resolve, 10)); } while (state.reason === preparing);
    assert.ok(state.binary, state.reason);
    helper = new DesktopHelper(0, { executable: state.binary, args: [] });
    const input = events => helper.request("input", { windowId: "0x2a", events });
    const snapshot = () => helper.request("fixture-state", {});
    await input([]);
    await input([{ type: "move", x: 20, y: 30 }]);
    await input([{ type: "up", x: 20, y: 30, button: "left" }]);
    assert.deepEqual(await snapshot(), { activations: 0, raises: 0, posts: [], buttons: 0, keys: 0 });
    await input([{ type: "down", x: 20, y: 30, button: "left" }]);
    let stateAfter = await snapshot();
    assert.equal(stateAfter.activations, 1); assert.equal(stateAfter.raises, 1); assert.equal(stateAfter.buttons, 1);
    await input([{ type: "move", x: 80, y: 90 }]);
    stateAfter = await snapshot();
    assert.equal(stateAfter.activations, 1); assert.equal(stateAfter.posts.at(-1).type, 6, "A held button produces leftMouseDragged");
    await helper.request("fixture-focus", { value: false });
    await input([{ type: "up", x: 80, y: 90, button: "left" }]);
    stateAfter = await snapshot();
    assert.equal(stateAfter.activations, 1); assert.equal(stateAfter.buttons, 0);
    assert.deepEqual(stateAfter.posts.at(-1), { type: 2, x: 180, y: 290 }, "Cleanup releases the held button at its recorded point without taking focus");
    const releasedCount = stateAfter.posts.length;
    await input([{ type: "up", x: 10, y: 10, button: "left" }]);
    assert.equal((await snapshot()).posts.length, releasedCount);
    await helper.request("fixture-focus", { value: true });
    await input([{ type: "click", x: 20, y: 30, button: "left", count: 1 }]);
    assert.equal((await snapshot()).activations, 1, "An already-focused window needs no repeated activation or raise");
    await input([{ type: "down", x: 20, y: 30, button: "left" }]);
    await helper.request("fixture-focus", { value: false });
    await input([{ type: "move", x: 90, y: 90 }]);
    stateAfter = await snapshot();
    assert.equal(stateAfter.activations, 1); assert.equal(stateAfter.buttons, 0, "Losing focus cancels a drag without stealing it back");
    assert.equal(stateAfter.posts.at(-1).type, 2);
    await helper.request("input", { windowId: "0xdead", events: [{ type: "up", x: 0, y: 0, button: "left" }] });
    assert.equal((await snapshot()).activations, 1, "A closed-window cleanup release is harmless");
    await input([{ type: "down", x: 20, y: 30, button: "left" }]);
    const dragging = await snapshot();
    await helper.request("input", { windowId: "0x2b", events: [{ type: "move", x: 40, y: 50 }] });
    assert.deepEqual(await snapshot(), dragging, "Hovering a different window must not cancel the active window's drag");
    await helper.request("input", { windowId: "0x2b", events: [{ type: "up", x: 40, y: 50, button: "left" }] });
    assert.deepEqual(await snapshot(), dragging, "A different window's stale release must not cancel the active drag");
    await input([{ type: "up", x: 20, y: 30, button: "left" }]);
    assert.equal((await snapshot()).buttons, 0);
    for (const focused of [true, false]) {
      await input([{ type: "down", x: 20, y: 30, button: "left" }]);
      const before = await snapshot();
      await helper.request("fixture-focus", { value: focused });
      await input([{ type: "move", x: 90, y: 95 }, { type: "up", x: 90, y: 95, button: "left" }]);
      const after = await snapshot();
      assert.equal(after.activations, before.activations, "A mixed move/up batch never reactivates the window");
      assert.equal(after.buttons, 0); assert.equal(after.posts.at(-1).type, 2);
    }
    await input([{ type: "down", x: 20, y: 30, button: "left" }]);
    const beforeStale = await snapshot();
    await assert.rejects(helper.request("input", { windowId: "0xdead", events: [{ type: "move", x: 0, y: 0 }, { type: "up", x: 0, y: 0, button: "left" }] }), /window/i);
    const afterStale = await snapshot();
    assert.equal(afterStale.buttons, 0); assert.equal(afterStale.activations, beforeStale.activations);
    await helper.request("fixture-focus", { value: true, minimized: true });
    await input([{ type: "key", key: "Enter", modifiers: [] }]);
    assert.equal((await helper.request("fixture-minimized", {})).value, false, "A stale focused flag must not skip unminimizing intentional input");
  } finally { await helper?.stop(); await cache.stop(); await rm(root, { recursive: true, force: true }); }
});
