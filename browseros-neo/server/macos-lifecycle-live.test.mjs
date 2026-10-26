import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MacHelperCache, preparing } from "./macos-helper.ts";
import { DesktopHelper } from "./helper.ts";
import { MacOSBackend } from "./macos.ts";
import { macHelperSource } from "./macos-source.ts";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 15000) {
  const end = Date.now() + timeout;
  let error;
  do { try { const value = await read(); if (value) return value; } catch (next) { error = next; } await sleep(50); } while (Date.now() < end);
  throw new Error("Lifecycle fixture timed out", { cause: error });
}
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let sequence = 0;
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const reply = JSON.parse(data), entry = pending.get(reply.id); if (!entry) return; pending.delete(reply.id); clearTimeout(entry.timer); reply.error ? entry.reject(new Error(JSON.stringify(reply.error))) : entry.resolve(reply.result); };
  ws.onclose = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Owned browser closed")); } pending.clear(); };
  return { ws, close: () => ws.close(), call: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 5000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  }) };
}

// Owns a separate browser profile and a neutral focus window. The only native
// substitution restricts enumeration to that profile's PID; all real CG/AX,
// capture, input, fit and close/reopen behavior remains production code.
test("macOS passive input preserves focus and the last window can close and reopen", {
  skip: process.platform !== "darwin" || process.env.PASEO_BROWSEROS_MAC_TEST !== "1", timeout: 180000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "browseros-mac-lifecycle-"));
  const profile = join(directory, "profile"), marker = "Paseo lifecycle isolated test";
  let source = macHelperSource.replace("import Darwin", "import Darwin\nvar fixturePID: pid_t = 0");
  source = source.replace("func isBrowser(_ app: NSRunningApplication) -> Bool {", "func isBrowser(_ app: NSRunningApplication) -> Bool {\n    guard app.processIdentifier == fixturePID else { return false }");
  source = source.replace("    [app.bundleIdentifier,", "    return [app.bundleIdentifier,");
  source = source.replace('        if method == "frame"', `        if method == "fixture-pid" { fixturePID = pid_t(number(params, "pid")); return ["ok": true] }
        if method == "fixture-focus" { return ["pid": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)] }
        if method == "fixture-originals" { return ["count": originals.count] }
        if method == "fixture-raw" {
            let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let ax = attribute(AXUIElementCreateApplication(fixturePID), kAXWindowsAttribute) as? [AXUIElement] ?? []
            return ["CG": raw.filter { number($0, kCGWindowOwnerPID as String) == Int(fixturePID) && number($0, kCGWindowLayer as String) == 0 },
                "AX": ax.map { ["title": attribute($0, kAXTitleAttribute) ?? null, "role": attribute($0, kAXRoleAttribute) ?? null, "subrole": attribute($0, kAXSubroleAttribute) ?? null] }]
        }
        if method == "frame"`);
  const cache = new MacHelperCache({ root: join(directory, "native"), source });
  let helper, backend, browser, page, sentinel, targetId, pid;
  const settings = { windowId: null, maxWidth: 640, maxHeight: 480, quality: 70, lossless: false, since: null, waitMs: 0 };
  async function scope() {
    const processes = execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" }).split("\n");
    const own = processes.find(line => line.includes("/Applications/BrowserOS neo.app/Contents/MacOS/BrowserOS neo --user-data-dir=" + profile));
    assert.ok(own, "Only our separate profile may be tested"); pid = Number(own.trim().split(/\s+/)[0]);
    await helper.request("fixture-pid", { pid });
  }
  async function attach() {
    const port = await until(async () => (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"));
    browser = await connect(`ws://127.0.0.1:${port[0]}${port[1]}`);
    const own = await until(async () => (await (await fetch(`http://127.0.0.1:${port[0]}/json/list`)).json()).find(target => target.type === "page" && target.url === "about:blank"));
    targetId = own.id; page = await connect(own.webSocketDebuggerUrl);
    await page.call("Runtime.evaluate", { expression: `document.title=${JSON.stringify(marker)}` });
    await scope();
  }
  async function launch() {
    await rm(join(profile, "DevToolsActivePort"), { force: true });
    execFileSync("/usr/bin/open", ["-na", "/Applications/BrowserOS neo.app", "--args", "--user-data-dir=" + profile, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--new-window", "about:blank"]);
    await attach();
  }
  async function frontmost() { return (await helper.request("fixture-focus", {})).pid; }
  async function neutral() { sentinel.stdin.write("focus\n"); await until(async () => await frontmost() === sentinel.pid); }
  try {
    const state = await until(() => { const value = cache.prepare(); return value.reason === preparing ? null : value; }, 180000);
    assert.ok(state.binary, state.reason);
    helper = new DesktopHelper(0, { executable: state.binary, args: [], env: { ...process.env, PASEO_BROWSEROS_PERMISSION_OWNER: process.execPath } });
    backend = new MacOSBackend(cache, () => {}, { helper });
    await launch();
    const initial = await until(async () => { const frame = await backend.capture(settings); return frame.windows.some(w => w.title.includes(marker)) ? frame : null; });
    const owned = initial.windows.find(w => w.title.includes(marker)); settings.windowId = owned.id;
    t.diagnostic("Initial native windows " + JSON.stringify(initial.windows));
    const sentinelPath = join(directory, "focus-sentinel");
    await writeFile(sentinelPath + ".swift", `import AppKit
import Foundation
import Darwin
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 300, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Paseo focus regression probe"
window.isReleasedWhenClosed = false
func focus() { window.makeKeyAndOrderFront(nil); application.activate(ignoringOtherApps: true) }
focus()
DispatchQueue.global().async { while let line = readLine() { if line == "focus" { DispatchQueue.main.async { focus() } } } }
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { application.terminate(nil) }; termination.resume()
application.run()
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", sentinelPath + ".swift", "-o", sentinelPath]);
    sentinel = spawn(sentinelPath, [], { stdio: ["pipe", "ignore", "ignore"] });
    await neutral();
    const observations = {};
    await backend.capture(settings); observations.capture = await frontmost();
    await neutral();
    const fit = await backend.fitDisplay({ width: 1000, height: 700 });
    assert.equal(fit.ok, true, fit.error); observations.fit = await frontmost();
    for (const kind of ["move", "up"]) {
      await neutral();
      const input = await backend.sendInput({ windowId: owned.id, events: [{ type: kind, x: 200, y: 200, ...(kind === "up" ? { button: "left" } : {}) }] });
      assert.equal(input.ok, true, input.error); await sleep(100); observations[kind] = await frontmost();
    }
    await t.test("capture, fit, hover and cleanup releases leave the neutral app focused", () => {
      t.diagnostic("Focus trace " + JSON.stringify({ sentinel: sentinel.pid, browser: pid, ...observations }));
      for (const [operation, actual] of Object.entries(observations)) assert.equal(actual, sentinel.pid, operation + " must not raise BrowserOS");
    });
    await page.call("Runtime.evaluate", { expression: "document.body.innerHTML='<input id=entry>'" });
    const click = await backend.sendInput({ windowId: owned.id, events: [{ type: "key", key: "l", modifiers: ["ctrl"] }] });
    assert.equal(click.ok, true, click.error); assert.equal(await frontmost(), pid, "An intentional key still activates the exact owned window");
    const beforeClose = await backend.capture(settings);
    await browser.call("Target.closeTarget", { targetId }); page.close(); page = null;
    await until(async () => (await helper.request("fixture-raw", {})).AX.length === 0, 3000);
    t.diagnostic("Closed native windows " + JSON.stringify(await helper.request("fixture-raw", {})));
    const closed = await backend.capture({ ...settings, since: beforeClose.hash });
    await t.test("closing the last standard window reports not-running", () => {
      t.diagnostic("Close trace " + JSON.stringify({ status: closed.status, windows: closed.windows, reason: closed.reason }));
      assert.equal(closed.status, "not-running"); assert.deepEqual(closed.windows, []); assert.equal(closed.image, null);
    });
    await until(async () => { await helper.request("restore", {}); return (await helper.request("fixture-originals", {})).count === 0; }, 3000);
    if (browser.ws.readyState === WebSocket.OPEN) {
      try { await browser.call("Target.createTarget", { url: "about:blank", newWindow: true }); browser.close(); await attach(); }
      catch { browser.close(); await launch(); }
    } else { browser.close(); await launch(); }
    const reopened = await until(async () => { const frame = await backend.capture(settings); return frame.status === "ready" && frame.windows.some(w => w.title.includes(marker)) ? frame : null; });
    assert.ok(reopened.image); assert.notEqual(reopened.windowId, owned.id);
    t.diagnostic("Reopened " + JSON.stringify({ id: reopened.windowId, width: reopened.windowWidth, height: reopened.windowHeight }));
  } finally {
    sentinel?.kill("SIGTERM");
    await backend?.stop(); await helper?.stop(); await cache.stop();
    page?.close(); try { await browser?.call("Browser.close"); } catch {} browser?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
