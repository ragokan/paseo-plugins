import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopHelper } from "./helper.ts";
import { MacHelperCache, preparing } from "./macos-helper.ts";
import { macHelperSource } from "./macos-source.ts";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function replace(source, start, end, body) {
  assert.ok(source.includes(start) && source.includes(end));
  return source.slice(0, source.indexOf(start)) + body + source.slice(source.indexOf(end, source.indexOf(start)));
}

test("native fitting keeps its original window after shrinking changes default order, then restores both position and size", {
  skip: process.platform !== "darwin", timeout: 180000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "browseros-mac-fit-"));
  // Fake only AX/window IO. The production fit/restore selection and bookkeeping run unchanged.
  let source = replace(macHelperSource, "func axFrame(", "struct BrowserWindow", `
var fixtureID: CGWindowID = 42
var fixtureMatch = true
var fixtureFrames: [CGWindowID: CGRect] = [42: CGRect(x: 120, y: 140, width: 2200, height: 1300), 43: CGRect(x: 300, y: 200, width: 1400, height: 1000)]
func axFrame(_ window: AXUIElement) -> CGRect? { fixtureFrames[fixtureID] }
func setFrame(_ window: AXUIElement, _ frame: CGRect) throws {
    fixtureFrames[fixtureID] = frame
    if let path = ProcessInfo.processInfo.environment["PASEO_BROWSEROS_FIT_RECORD"] {
        let snapshot = fixtureFrames.map { ["id": Int($0.key), "x": Int($0.value.minX), "y": Int($0.value.minY), "width": Int($0.value.width), "height": Int($0.value.height)] }
        try JSONSerialization.data(withJSONObject: snapshot).write(to: URL(fileURLWithPath: path))
    }
}
`);
  source = replace(source, "func matchingAX(", "// Callbacks never", `
func matchingAX(_ target: BrowserWindow) -> AXUIElement? { fixtureID = target.id; return fixtureMatch ? AXUIElementCreateApplication(getpid()) : nil }
`);
  source = replace(source, "    private func permissions()", "    func windows()", "    private func permissions() -> String? { nil }\n");
  source = replace(source, "    func windows()", "    private func selected(", `
    func windows() -> [BrowserWindow] {
        fixtureFrames.map { BrowserWindow(id: $0.key, app: NSRunningApplication.current, title: String($0.key), frame: $0.value, minimized: false, focused: true) }.sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
    }
`);
  source = source.replace('        if method == "frame"', '        if method == "fixture-geometry" { return ["windows": windows().map { ["id": $0.hex, "x": Int($0.frame.minX), "y": Int($0.frame.minY), "width": Int($0.frame.width), "height": Int($0.frame.height)] }] }\n        if method == "frame"');
  source = source.replace('        if method == "frame"', '        if method == "fixture-match" { fixtureMatch = params["enabled"] as? Bool ?? true; return ["ok": true] }\n        if method == "frame"');
  source = source.replace('        if method == "frame"', '        if method == "fixture-slow" { try await Task.sleep(nanoseconds: 300_000_000); return ["ok": true] }\n        if method == "frame"');
  const cache = new MacHelperCache({ root: directory, source });
  let helper, pipeChild;
  try {
    let state;
    do { state = cache.prepare(); if (state.reason === preparing) await sleep(20); } while (state.reason === preparing);
    assert.ok(state.binary, state.reason);
    helper = new DesktopHelper(0, { executable: state.binary, args: [] });
    await assert.rejects(helper.request("fixture-geometry", { since: "\ud83d" }, 1000), /format|JSON/i, "Unparseable Unicode must return its request id immediately, without a transport timeout");
    const geometry = async () => (await helper.request("fixture-geometry", {})).windows;
    const original = await geometry();
    await helper.request("fit", { width: 1000, height: 700 });
    assert.equal((await geometry())[0].id, "0x2b", "Another window becomes largest after the fit");
    await helper.request("fit", { width: 1100, height: 750 });
    const next = await geometry();
    assert.deepEqual(next.find(w => w.id === "0x2b"), original.find(w => w.id === "0x2b"), "Repeated fitting must leave the other window alone");
    assert.equal(next.find(w => w.id === "0x2a").width, 1100);
    await helper.request("fixture-match", { enabled: false });
    await assert.rejects(helper.request("restore", {}), /identify.*restore/i);
    await helper.request("fixture-match", { enabled: true });
    await helper.request("restore", {});
    assert.deepEqual(await geometry(), original);
    await helper.stop(); helper = null;
    const record = join(directory, "geometry.json");
    pipeChild = spawn(state.binary, [], { env: { ...process.env, PASEO_BROWSEROS_FIT_RECORD: record }, stdio: ["pipe", "pipe", "pipe"] });
    pipeChild.stderr.resume();
    const fitted = once(pipeChild.stdout, "data");
    pipeChild.stdin.write(JSON.stringify({ id: 1, method: "fit", params: { width: 1000, height: 700 } }) + "\n");
    assert.equal(JSON.parse(String((await fitted)[0])).result.ok, true);
    const exited = once(pipeChild, "exit");
    pipeChild.stdout.destroy();
    pipeChild.stdin.end(JSON.stringify({ id: 2, method: "fixture-slow", params: {} }) + "\n");
    let timer;
    const [code, signal] = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Closed-pipe shutdown timed out")), 5000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(signal, null, "A closed response pipe must not kill the helper with SIGPIPE");
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(await readFile(record, "utf8")).find(w => w.id === 42), { id: 42, x: 120, y: 140, width: 2200, height: 1300 }, "Parent loss restores the fitted window");
  } finally {
    if (pipeChild && pipeChild.exitCode === null && pipeChild.signalCode === null) pipeChild.kill("SIGKILL");
    await helper?.stop(); await cache.stop(); await rm(directory, { recursive: true, force: true });
  }
});
