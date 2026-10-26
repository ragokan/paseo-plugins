import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserDaemon } from "./daemon.ts";
import { LinuxBackend } from "./linux.ts";
import { createBackend, MacOSBackend, UnsupportedBackend } from "./backend.ts";

const input = { windowId: null, maxWidth: 1280, maxHeight: 880, quality: 80, lossless: false, since: null, waitMs: 0 };
const frame = { status: "ready", reason: null, windows: [{ id: "0x123", title: "Static", width: 1280, height: 880, focused: true, minimized: false }], windowId: "0x123", windowWidth: 1280, windowHeight: 880, imageWidth: 1280, imageHeight: 880, hash: "one.j", image: "/9j/fixture", mimeType: "image/jpeg", changed: true };

test("platform selection keeps Linux native resources lazy and other systems explicit", async () => {
  assert.ok(createBackend("linux") instanceof LinuxBackend);
  assert.ok(createBackend("darwin") instanceof MacOSBackend);
  const backend = createBackend("win32");
  assert.ok(backend instanceof UnsupportedBackend);
  assert.match((await backend.capture(input)).reason, /win32/);
});

test("a viewer's since bypasses its cached frame immediately, while newcomers share it", async () => {
  let captures = 0;
  const daemon = new BrowserDaemon(new LinuxBackend({
    async request(method) {
      if (method === "changed") return { supported: true, changed: true };
      return { ...frame, hash: ++captures === 1 ? "one.j" : "two.j" };
    }, async stop() {},
  }));
  try {
    const first = await daemon.readFrame(input);
    assert.equal((await daemon.readFrame(input)).hash, first.hash);
    assert.equal(captures, 1, "a newcomer shares the recent capture");
    const next = await daemon.readFrame({ ...input, since: first.hash, waitMs: 0 });
    assert.equal(next.hash, "two.j", "an equal since must cause a fresh capture, even with waitMs zero");
    assert.equal(captures, 2);
  } finally { await daemon.stop(); }
});

test("damage checks suppress idle captures, retain the one-second safety capture, and fall back to 33 ms", async () => {
  for (const supported of [true, false]) {
    let captures = 0;
    let checks = 0;
    const daemon = new BrowserDaemon(new LinuxBackend({
      async request(method) {
        if (method === "changed") { checks++; return { supported, changed: false }; }
        captures++;
        return frame;
      }, async stop() {},
    }));
    try {
      const result = await daemon.readFrame({ ...input, since: frame.hash, waitMs: supported ? 1100 : 130 });
      assert.equal(result.changed, false);
      assert.ok(checks > 5);
      if (supported) assert.equal(captures, 2, "idle damage mode captures once plus the one-second safety frame");
      else assert.ok(captures >= 3 && captures <= 5, `fallback must sample about every 33 ms: ${captures}`);
    } finally { await daemon.stop(); }
  }
});

test("a damage notification wakes a long poll promptly", async () => {
  let damaged = false;
  const daemon = new BrowserDaemon(new LinuxBackend({
    async request(method) {
      if (method === "changed") { damaged = true; return { supported: true, changed: true }; }
      return { ...frame, hash: damaged ? "new.j" : frame.hash };
    }, async stop() {},
  }));
  try {
    const start = performance.now();
    assert.equal((await daemon.readFrame({ ...input, since: frame.hash, waitMs: 500 })).hash, "new.j");
    assert.ok(performance.now() - start < 80);
  } finally { await daemon.stop(); }
});

test("concurrent viewers with an old since share the fresh frame rather than queue duplicate captures", async () => {
  let captures = 0;
  const daemon = new BrowserDaemon(new LinuxBackend({
    async request() {
      captures++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...frame, hash: captures === 1 ? "one.j" : "two.j" };
    }, async stop() {},
  }));
  try {
    const first = await daemon.readFrame(input);
    const next = await Promise.all(Array.from({ length: 4 }, () => daemon.readFrame({ ...input, since: first.hash })));
    assert.ok(next.every((value) => value.hash === "two.j"));
    assert.equal(captures, 2);
  } finally { await daemon.stop(); }
});

test("a cold Node cache retains helper image bytes even when the first caller already has the frame", async () => {
  const daemon = new BrowserDaemon(new LinuxBackend({
    async request(_method, params) {
      return params.since === frame.hash && !params.includeImage ? { ...frame, image: null } : frame;
    }, async stop() {},
  }));
  try {
    assert.equal((await daemon.readFrame({ ...input, since: frame.hash })).image, null);
    const newcomer = await daemon.readFrame(input);
    assert.equal(newcomer.image, frame.image);
    assert.equal(newcomer.changed, true);
  } finally { await daemon.stop(); }
});
