import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import contribute from "../index.server.ts";
import { BrowserDaemon } from "./daemon.ts";
import { DesktopHelper } from "./helper.ts";
import { helperSource } from "./helper-source.ts";
import { readFrame } from "../shared/contracts.ts";

const request = { windowId: null, maxWidth: 1000, maxHeight: 800, quality: 70, since: null, waitMs: 0 };
const frame = {
  status: "ready", reason: null,
  windows: [{ id: "0x123", title: "Fixture", width: 1840, height: 1048, focused: true, minimized: false }],
  windowId: "0x123", windowWidth: 1840, windowHeight: 1048,
  hash: "first", changed: true, image: "/9j/fixture", mimeType: "image/jpeg", imageWidth: 1000, imageHeight: 569,
};

function pure(cases) {
  const result = spawnSync("python3", ["-c", helperSource, "--selftest"], {
    input: JSON.stringify(cases), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("DOM keys map to X11 key names and Unicode keysyms", () => {
  const keys = ["Enter", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "PageUp", "PageDown", "ContextMenu", "F1", "F12", " ", "a", "A", "/", "é", "漢", "😀"];
  assert.deepEqual(pure({ keys }).keys, ["Return", "BackSpace", "Left", "Right", "Up", "Down",
    "Prior", "Next", "Menu", "F1", "F12", 32, 97, 65, 47, 233, 0x01006f22, 0x0101f600]);
});

test("fit scaling preserves aspect ratio, fits both bounds and never upscales", () => {
  const sizes = [[1840, 1048, 1000, 800], [590, 864, 1000, 400], [40, 20, 64, 64],
    [100, 100, 64, 80], [10000, 1, 64, 64]];
  assert.deepEqual(pure({ sizes }).sizes, [[1000, 569], [273, 400], [40, 20], [64, 64], [64, 1]]);
});

test("default window ignores focus, excludes minimized windows and breaks ties by numeric X11 id", () => {
  const source = helperSource.replace("if __name__ == '__main__':\n    main()", "") + `
from types import SimpleNamespace
d = Desktop.__new__(Desktop)
d.root = 1
fixtures = {
    16: dict(width=1840, height=1048, minimized=False),
    15: dict(width=1840, height=1048, minimized=False),
    17: dict(width=590, height=864, minimized=False),
    18: dict(width=3000, height=2000, minimized=True),
}
d.is_browser = lambda window: True
d.attributes = lambda window: SimpleNamespace(**fixtures[window])
d.title = lambda window: str(window)
d.atom = lambda name: 99
results = []
for focused in (17, 16, 18):
    def prop(window, name):
        if name == '_NET_ACTIVE_WINDOW': return [focused]
        if name == '_NET_CLIENT_LIST_STACKING': return list(fixtures)
        if name == 'WM_STATE': return [3 if fixtures[window]['minimized'] else 1]
        return []
    d.prop = prop
    results.append([window['id'] for window in d.windows()])
print(json.dumps(results))
`;
  const result = spawnSync("python3", ["-c", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), Array.from({ length: 3 }, () => ["0xf", "0x10", "0x11", "0x12"]));
});

test("missing X11 is reported as unsupported without crashing the helper", () => {
  const result = spawnSync("python3", ["-u", "-c", helperSource], {
    env: { ...process.env, DISPLAY: ":98765", GDK_BACKEND: "x11" },
    input: JSON.stringify({ id: 1, method: "frame", params: request }) + "\n", encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.id, 1);
  assert.equal(response.result.status, "unsupported");
  assert.equal(response.result.mimeType, "image/jpeg");
  assert.match(response.result.reason, /X11/);
  assert.deepEqual(response.result.windows, []);
});

test("simultaneous viewers share capture and equal hashes omit the JPEG", async () => {
  let calls = 0;
  const daemon = new BrowserDaemon({
    async request() { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return frame; },
    async stop() {},
  });
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => daemon.readFrame(request)));
    assert.equal(calls, 1);
    assert.ok(results.every((item) => item.image === frame.image && item.changed));
    const unchanged = await daemon.readFrame({ ...request, since: frame.hash, waitMs: 130 });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.image, null);
    assert.equal(unchanged.hash, frame.hash);
    assert.ok(calls <= 3, `expected shared captures, got ${calls}`);
  } finally { await daemon.stop(); }
});

test("long poll returns new pixels and current window metadata", async () => {
  let calls = 0;
  const daemon = new BrowserDaemon({
    async request() { return ++calls === 1 ? frame : { ...frame, hash: "second", image: "/9j/new" }; },
    async stop() {},
  });
  try {
    const result = await daemon.readFrame({ ...request, since: frame.hash, waitMs: 500 });
    assert.equal(result.changed, true);
    assert.equal(result.hash, "second");
    assert.equal(result.image, "/9j/new");
    assert.deepEqual(result.windows, frame.windows);
  } finally { await daemon.stop(); }
});

test("viewers share unchanged helper captures without losing cached image bytes", async () => {
  const seen = [];
  const daemon = new BrowserDaemon({
    async request(_method, input) {
      seen.push(input);
      const lossless = input.lossless ?? false;
      const value = { ...frame, hash: lossless ? "png" : "jpeg", mimeType: lossless ? "image/png" : "image/jpeg",
        image: lossless ? "iVBORw0KGgo-fixture" : frame.image };
      return input.since === value.hash ? { ...value, image: null, changed: false } : value;
    },
    async stop() {},
  });
  try {
    const first = await daemon.readFrame({ ...request, lossless: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const unchanged = await daemon.readFrame({ ...request, lossless: true, since: first.hash });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.image, null);
    assert.equal(unchanged.mimeType, "image/png");
    assert.equal(seen[1].since, first.hash);
    const newcomer = await daemon.readFrame({ ...request, lossless: true });
    assert.equal(newcomer.changed, true);
    assert.equal(newcomer.image, first.image);
    const jpeg = await daemon.readFrame({ ...request, lossless: false });
    assert.equal(jpeg.mimeType, "image/jpeg");
    assert.notEqual(jpeg.hash, first.hash);
    assert.equal(seen.length, 3, "JPEG and PNG use different capture keys");
  } finally { await daemon.stop(); }
});

test("cleanup wakes long polls and stops the helper", async () => {
  let stopped = false;
  const daemon = new BrowserDaemon({ async request() { return frame; }, async stop() { stopped = true; } });
  const pending = daemon.readFrame({ ...request, since: frame.hash, waitMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await daemon.stop();
  assert.equal(stopped, true);
  assert.equal((await pending).status, "unsupported");
});

test("expected helper failures are returned through the contracts", async () => {
  const daemon = new BrowserDaemon({ async request() { throw new Error("No X11 desktop"); }, async stop() {} });
  try {
    assert.equal((await daemon.readFrame(request)).status, "unsupported");
    assert.equal((await daemon.readFrame(request)).mimeType, "image/jpeg");
    assert.deepEqual(await daemon.sendInput({ windowId: "0x123", events: [{ type: "key", key: "a", modifiers: [] }] }),
      { ok: false, error: "No X11 desktop" });
  } finally { await daemon.stop(); }
});

test("live registered RPC captures a BrowserOS JPEG and long polls", async (t) => {
  const handlers = new Map();
  const cleanup = contribute({ handle(contract, handler) { handlers.set(contract.name, handler); } });
  const read = handlers.get("frame.read");
  try {
    assert.deepEqual([...handlers.keys()], ["frame.read", "input.send", "display.fit", "browser.launch"]);
    const first = readFrame.output.parse(await read(request));
    assert.equal(first.status, "ready", first.reason ?? "BrowserOS must be running for the live check");
    assert.match(first.image, /^\/9j\//);
    assert.equal(first.mimeType, "image/jpeg");
    assert.ok(first.imageWidth <= request.maxWidth && first.imageHeight <= request.maxHeight);
    assert.ok(first.imageWidth <= first.windowWidth && first.imageHeight <= first.windowHeight);
    assert.equal(first.changed, true);
    const start = performance.now();
    const second = readFrame.output.parse(await read({ ...request, windowId: first.windowId, since: first.hash, waitMs: 300 }));
    if (second.hash === first.hash) {
      assert.equal(second.changed, false);
      assert.equal(second.image, null);
      assert.ok(performance.now() - start >= 280);
    } else {
      assert.equal(second.changed, true);
      assert.match(second.image, /^\/9j\//);
      t.diagnostic("The live page changed during the long poll (animation or user activity).");
    }
    assert.ok(second.windows.length > 0);
    const fallback = readFrame.output.parse(await read({ ...request, windowId: "0xdeadbeef" }));
    assert.equal(fallback.windowId, fallback.windows[0].id);
  } finally { await cleanup(); }
});

test("helper starts lazily, expires when idle and restarts after a crash", async () => {
  const helper = new DesktopHelper(40);
  try {
    assert.equal(helper.child, null);
    await helper.request("frame", request);
    const first = helper.child;
    assert.ok(first?.pid);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(helper.child, null);
    await helper.request("frame", request);
    assert.ok(helper.child?.pid);
    assert.notEqual(helper.child.pid, first.pid);
    const second = helper.child;
    const crashed = new Promise((resolve) => second.once("close", resolve));
    second.kill("SIGKILL");
    await crashed;
    await helper.request("frame", request);
    assert.ok(helper.child?.pid);
    assert.notEqual(helper.child.pid, second.pid);
  } finally { await helper.stop(); }
});
