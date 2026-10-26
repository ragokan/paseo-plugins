import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MacHelperCache, helperPath, preparing, toolchainNeeded } from "./macos-helper.ts";
import { MacOSBackend } from "./macos.ts";
import { macHelperSource } from "./macos-source.ts";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(cache) {
  for (let i = 0; i < 2000; i++) {
    const state = cache.prepare();
    if (state.reason !== preparing) return state;
    await sleep(10);
  }
  assert.fail("Helper preparation timed out");
}

function runner(options = {}) {
  const calls = [];
  return { calls, execute: async (file, args, config) => {
    calls.push([file, args]);
    if (file.endsWith("sw_vers")) return { stdout: options.version ?? "14.0", stderr: "" };
    if (args[0] === "--find") {
      if (options.missing) throw new Error("missing swiftc");
      return { stdout: "/usr/bin/swiftc", stderr: "" };
    }
    await options.compile?.(config);
    await writeFile(args.at(-1), "binary", { mode: 0o755 });
    return { stdout: "", stderr: "" };
  } };
}

test("compile cache returns immediately, shares work, atomically publishes and reuses the executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "browseros-mac-cache-"));
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fake = runner({ compile: () => gate });
  const cache = new MacHelperCache({ root, source: "fixture", execute: fake.execute });
  try {
    const start = performance.now();
    assert.deepEqual(cache.prepare(), { reason: preparing });
    assert.ok(performance.now() - start < 50);
    while (!fake.calls.some(([, args]) => args[0] === "swiftc")) await sleep(5);
    assert.equal(cache.prepare().reason, preparing);
    assert.ok(!(await readdir(dirname(cache.binary))).includes("helper"));
    release();
    assert.deepEqual(await ready(cache), { binary: helperPath("fixture", root) });
    assert.deepEqual(await readdir(dirname(cache.binary)), ["helper"]);
    const reuse = runner();
    const second = new MacHelperCache({ root, source: "fixture", execute: reuse.execute });
    assert.deepEqual(await ready(second), { binary: cache.binary });
    assert.equal(reuse.calls.length, 1, "cached binary needs only the OS version check");
    await second.stop();
    assert.equal(fake.calls.filter(([, args]) => args[0] === "swiftc").length, 1);
    assert.notEqual(helperPath("different", root), cache.binary);
  } finally { release(); await cache.stop(); await rm(root, { recursive: true, force: true }); }
});

test("old macOS and a missing toolchain produce stable actionable failures without repeated compilation", async () => {
  const root = await mkdtemp(join(tmpdir(), "browseros-mac-errors-"));
  try {
    for (const options of [{ version: "13.6.9" }, { missing: true }]) {
      const fake = runner(options);
      const cache = new MacHelperCache({ root, execute: fake.execute });
      const state = await ready(cache);
      if (options.version) assert.match(state.reason, /macOS 13\.6\.9/);
      else assert.equal(state.reason, toolchainNeeded);
      const count = fake.calls.length;
      assert.deepEqual(cache.prepare(), state);
      assert.equal(fake.calls.length, count);
      assert.equal(fake.calls.some(([, args]) => args[0] === "swiftc"), false);
      await cache.stop();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stopping compilation aborts the compiler and never publishes a partial executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "browseros-mac-stop-"));
  const fake = runner({ compile: ({ signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  const cache = new MacHelperCache({ root, execute: fake.execute });
  try {
    cache.prepare();
    while (!fake.calls.some(([, args]) => args[0] === "swiftc")) await sleep(5);
    await cache.stop();
    assert.match(cache.prepare().reason, /stopped/);
    assert.deepEqual(await readdir(dirname(cache.binary)), []);
  } finally { await cache.stop(); await rm(root, { recursive: true, force: true }); }
});

test("macOS fitting shares debounce, honors actual clamped dimensions and restores after idle and stop", async () => {
  const calls = [];
  const backend = new MacOSBackend(undefined, () => {}, { debounceMs: 10, idleMs: 100, helper: {
    async request(method, input) {
      calls.push([method, input]);
      return { ok: true, error: null, width: method === "fit" ? 1000 : 1500, height: 700 };
    }, async stop() { calls.push(["stop"]); },
  } });
  try {
    const a = backend.fitDisplay({ width: 1200, height: 900 });
    const b = backend.fitDisplay({ width: 1800, height: 1000 });
    assert.deepEqual(await a, { ok: true, width: 1000, height: 700, error: null });
    assert.deepEqual(await b, await a);
    assert.deepEqual(calls, [["fit", { width: 1800, height: 1000 }]]);
    await sleep(65); backend.frameRead(); await sleep(65);
    assert.equal(calls.length, 1);
    await sleep(65);
    assert.equal(calls[1][0], "restore");
    await backend.fitDisplay({ width: 1280, height: 720 });
  } finally { await backend.stop(); }
  assert.deepEqual(calls.map(([method]) => method), ["fit", "restore", "fit", "restore", "stop"]);
});

test("native Swift pure checks cover keys, Mac shortcut modifiers, Retina sizing and UTF-16 chunk boundaries", { skip: process.platform !== "darwin", timeout: 180_000 }, async () => {
  const cache = new MacHelperCache();
  try {
    const state = await ready(cache);
    assert.ok(state.binary, state.reason);
    const text = "x".repeat(19) + "😀 é 漢 👩‍🚒".repeat(5);
    const result = spawnSync(state.binary, ["--selftest"], { encoding: "utf8", input: JSON.stringify({
      keys: ["Enter", "Tab", " ", "Backspace", "Escape", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "F1", "F12", "a", "L", "/", "?", "unknown"],
      modifiers: [{ key: "l", modifiers: ["ctrl"] }, { key: "Tab", modifiers: ["ctrl", "shift"] }, { key: "a", modifiers: ["meta", "alt", "shift"] }],
      sizes: [[2000, 1000, 800, 600], [1200, 800, 2400, 1600], [800, 1328, 2560, 1362], [4096, 2400, 2560, 1362]], text,
    }) });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.deepEqual(actual.keys, [36, 48, 49, 51, 53, 117, 115, 119, 116, 121, 123, 124, 125, 126, 122, 111, 0, 37, 44, 44, null]);
    assert.deepEqual(actual.modifiers, [1 << 20, (1 << 18) | (1 << 17), (1 << 18) | (1 << 19) | (1 << 17)]);
    assert.deepEqual(actual.sizes, [[800, 400], [1200, 800], [800, 1328], [2324, 1362]]);
    assert.ok(actual.chunks.every(chunk => chunk.length > 0 && chunk.length <= 20 && !(chunk.at(-1) >= 0xd800 && chunk.at(-1) <= 0xdbff)));
    assert.equal(String.fromCharCode(...actual.chunks.flat()), text);
  } finally { await cache.stop(); }
});

test("macOS normalizes malformed UTF-16 before the native JSON parser while preserving Unicode", async () => {
  const calls = [];
  const backend = new MacOSBackend(undefined, () => {}, { helper: {
    async request(method, params) { calls.push([method, params]); return { ok: true, error: null }; }, async stop() {},
  } });
  const events = [{ type: "text", text: "a\ud83d é 漢 😀 \ude01" }, { type: "key", key: "\ud83d", modifiers: [] }];
  try {
    assert.equal((await backend.sendInput({ windowId: "0x1", events })).ok, true);
    assert.deepEqual(calls, [["input", { windowId: "0x1", events: [{ type: "text", text: "a� é 漢 😀 �" }, { type: "key", key: "�", modifiers: [] }] }]]);
    assert.equal(events[0].text, "a\ud83d é 漢 😀 \ude01", "Do not mutate the caller's input");
  } finally { await backend.stop(); }
});
