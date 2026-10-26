import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MacHelperCache, preparing } from "./macos-helper.ts";
import { DesktopHelper } from "./helper.ts";
import { MacOSBackend } from "./macos.ts";
import { BrowserDaemon } from "./daemon.ts";
import { macHelperSource } from "./macos-source.ts";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  do { try { const result = await read(); if (result) return result; } catch (error) { last = error; } await sleep(50); } while (Date.now() < deadline);
  throw new Error("Timed out waiting for test state", { cause: last });
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    clearTimeout(request.timer);
    value.error ? request.reject(new Error(JSON.stringify(value.error))) : request.resolve(value.result);
  };
  return {
    call(method, params = {}) { return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    }); },
    close() { socket.close(); },
  };
}

// Explicit opt-in: creates a separate BrowserOS profile; never targets an existing tab.
// Run with PASEO_BROWSEROS_MAC_TEST=1 node --test server/macos-live.test.mjs.
test("live macOS frames, refinement, menus, native input, fitting, restore and performance", {
  skip: process.platform !== "darwin" || process.env.PASEO_BROWSEROS_MAC_TEST !== "1", timeout: 180000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "browseros-mac-live-"));
  const profile = join(directory, "profile");
  // Scope discovery before the first capture, including every default-window
  // fallback and fit. A larger user window can never become a test target.
  const source = macHelperSource.replace("func isBrowser(_ app: NSRunningApplication) -> Bool {", 'func isBrowser(_ app: NSRunningApplication) -> Bool {\n    guard app.processIdentifier == pid_t(ProcessInfo.processInfo.environment["PASEO_BROWSEROS_TEST_PID"] ?? "-1") else { return false }')
    .replace("    [app.bundleIdentifier,", "    return [app.bundleIdentifier,");
  const cache = new MacHelperCache({ root: join(directory, "native"), source });
  const state = await until(() => { const value = cache.prepare(); return value.reason === preparing ? null : value; }, 180000);
  assert.ok(state.binary, state.reason);
  const permissions = JSON.parse(execFileSync(state.binary, ["--permissions"], { encoding: "utf8" }));
  assert.deepEqual(permissions, { screenRecording: true, accessibility: true }, "Grant permissions to the actual test host before opting in");
  const app = process.env.PASEO_BROWSEROS_MAC_APP ?? "/Applications/BrowserOS neo.app";
  await access(app);
  let browser, page, backend, daemon, helperPid, ownedWindowId;
  const metrics = {};
  const html = `<!doctype html><title>Paseo macOS isolated test</title><style>body{margin:0;background:#f3f6fa;font:24px sans-serif}header{padding:24px;background:#124c72;color:white}input,button{font:24px sans-serif;margin:20px;padding:12px}#motion{height:140px;margin:20px;background:#e67432}section{height:4000px;padding:20px;background:linear-gradient(#f3f6fa,#81c6df)}</style><header>BrowserOS Neo macOS native test</header><input id=entry placeholder="Native input test"><button id=button onclick="clicks++">Click me</button><div id=motion></div><section>Scroll this test page only</section><script>window.clicks=0;window.moving=false;let n=0;function animate(){if(!moving)return;document.querySelector('#motion').style.background='hsl('+((n++*7)%360)+' 75% 55%)';requestAnimationFrame(animate)}</script>`;
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const settings = { windowId: null, maxWidth: 1280, maxHeight: 900, quality: 80, lossless: true, since: null, waitMs: 0 };
  const artifact = async (name, frame) => {
    assert.ok(frame.image && frame.hash, frame.reason ?? "Empty image");
    assert.ok(frame.imageWidth <= settings.maxWidth && frame.imageHeight <= settings.maxHeight);
    await writeFile(join(directory, name + (frame.mimeType === "image/png" ? ".png" : ".jpg")), Buffer.from(frame.image, "base64"));
  };
  const read = async (input = {}) => {
    const start = performance.now();
    const result = await daemon.readFrame({ ...settings, ...input });
    metrics.lastRequestMs = performance.now() - start;
    assert.equal(result.status, "ready", result.reason);
    assert.equal(result.windowId, ownedWindowId);
    return result;
  };
  const evaluate = async expression => (await page.call("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  const input = async events => {
    const result = await daemon.sendInput({ windowId: ownedWindowId, events });
    assert.equal(result.ok, true, result.error);
    await sleep(120);
  };
  try {
    execFileSync("/usr/bin/open", ["-na", app, "--args", "--user-data-dir=" + profile, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--new-window", url]);
    const portFile = await until(async () => { const lines = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"); return lines.length === 2 ? lines : null; });
    browser = await connect(`ws://127.0.0.1:${portFile[0]}${portFile[1]}`);
    const targets = await until(async () => (await browser.call("Target.getTargets")).targetInfos.find(target => target.type === "page" && target.url === url));
    const pages = await (await fetch(`http://127.0.0.1:${portFile[0]}/json/list`)).json();
    page = await connect(pages.find(target => target.id === targets.targetId).webSocketDebuggerUrl);
    await until(() => evaluate("document.querySelector('#entry') !== null"));
    const { windowId } = await browser.call("Browser.getWindowForTarget", { targetId: targets.targetId });
    await browser.call("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await browser.call("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 30, width: 2200, height: 1300 } });
    const ownProcess = execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" }).split("\n").find(line => line.replace(/^\s*\d+\s+/, "").startsWith(app + "/Contents/MacOS/") && line.includes("--user-data-dir=" + profile));
    assert.ok(ownProcess, "The isolated BrowserOS process must exist before capture");
    const ownPid = ownProcess.trim().split(/\s+/)[0];
    const transport = new DesktopHelper(0, { executable: state.binary, args: [], env: { ...process.env, PASEO_BROWSEROS_PERMISSION_OWNER: process.execPath, PASEO_BROWSEROS_TEST_PID: ownPid } });
    backend = new MacOSBackend(cache, () => {}, { helper: transport, debounceMs: 20, idleMs: 1000 });
    daemon = new BrowserDaemon(backend);
    let first = await until(async () => {
      const frame = await backend.capture(settings);
      assert.notEqual(frame.status, "unsupported", frame.reason);
      const own = frame.windows.find(window => window.title.includes("Paseo macOS isolated test"));
      if (own) { ownedWindowId = own.id; return frame; }
    });
    settings.windowId = ownedWindowId;
    const ownWindow = first.windows.find(window => window.id === ownedWindowId);
    t.diagnostic("Owned test window " + JSON.stringify(ownWindow));
    first = await read();
    assert.equal(first.mimeType, "image/jpeg");
    await artifact("first", first);
    metrics.firstFrameMs = metrics.lastRequestMs;
    await page.call("Runtime.evaluate", { expression: "document.querySelector('#entry').blur()" });
    let refined = first;
    for (let i = 0; i < 30 && refined.mimeType !== "image/png"; i++) { await sleep(100); refined = await read({ since: refined.hash, waitMs: 500 }); }
    assert.equal(refined.mimeType, "image/png");
    assert.ok(refined.hash.endsWith(".p"));
    await artifact("still", { ...refined, image: refined.image ?? (await read()).image });
    const unchanged = await read({ since: refined.hash, waitMs: 250 });
    assert.equal(unchanged.image, null); assert.equal(unchanged.changed, false);
    metrics.unchangedPollMs = metrics.lastRequestMs;

    // Use only DOM bounds in the owned page and its measured browser chrome offset.
    const geometry = await evaluate("({outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio})");
    const offset = { x: ownWindow.width - geometry.innerWidth, y: ownWindow.height - geometry.innerHeight };
    const point = async selector => {
      const rect = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      return { x: offset.x + rect.x, y: offset.y + rect.y };
    };
    // Prefer CDP's layout metrics when a side panel adds horizontal chrome.
    const entryPoint = await point("#entry");
    await input([{ type: "click", ...entryPoint, button: "left", count: 1 }, { type: "text", text: "ASCII + é 漢 😀" }]);
    assert.equal(await evaluate("document.querySelector('#entry').value"), "ASCII + é 漢 😀");
    await input([{ type: "key", key: "a", modifiers: ["ctrl"] }, { type: "text", text: "Replaced Ω" }]);
    assert.equal(await evaluate("document.querySelector('#entry').value"), "Replaced Ω");
    await input([{ type: "click", ...await point("#button"), button: "left", count: 1 }]);
    assert.equal(await evaluate("clicks"), 1);
    await input([{ type: "key", key: "l", modifiers: ["ctrl"] }, { type: "text", text: url + "?command-l=works" }, { type: "key", key: "Enter", modifiers: [] }]);
    await until(() => evaluate("location.search === '?command-l=works'"));
    await input([{ type: "scroll", x: offset.x + 700, y: offset.y + 500, dx: 0, dy: 8 }]);
    await until(() => evaluate("scrollY > 0"));
    metrics.scrollY = await evaluate("scrollY");
    await evaluate("scrollTo(0,0)");
    await input([{ type: "click", x: offset.x + 800, y: offset.y + 400, button: "right", count: 1 }]);
    const menu = await read(); await artifact("context-menu", menu);
    await input([{ type: "key", key: "Escape", modifiers: [] }]);

    const ps = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
    helperPid = ps.split("\n").find(line => line.trim().split(/\s+/)[1] === String(process.pid) && line.includes(state.binary))?.trim().split(/\s+/)[0];
    const cpuSeconds = () => {
      if (!helperPid) return null;
      const value = execFileSync("/bin/ps", ["-o", "time=", "-p", helperPid], { encoding: "utf8" }).trim();
      return value.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
    };
    const measure = async moving => {
      await evaluate("window.moving=" + moving + (moving ? ";animate()" : "")); await sleep(300);
      let frame = await read(); let count = 0; const durations = [];
      const start = performance.now(), cpu = cpuSeconds();
      while (performance.now() - start < 4000) {
        frame = await read({ since: frame.hash, waitMs: 1500 });
        durations.push(metrics.lastRequestMs); if (frame.changed) count++;
      }
      const elapsed = (performance.now() - start) / 1000;
      return { fps: count / elapsed, meanResponseMs: durations.reduce((a,b) => a+b,0)/durations.length,
        helperCpuPercent: cpu === null ? null : 100 * (cpuSeconds() - cpu) / elapsed };
    };
    metrics.still = await measure(false);
    metrics.moving = await measure(true);
    await evaluate("window.moving=false");
    const last = await read();
    assert.equal((await backend.changed({ ...settings, since: last.hash })).supported, true, "Live capture uses SCStream");
    await sleep(31000);
    assert.equal((await backend.changed({ ...settings, since: last.hash })).supported, false, "SCStream stops after thirty seconds without frame requests");
    await read();

    // display.fit has no window id in the shared contract. Refuse it unless the
    // helper's actual default is ours; this guard protects the user's windows.
    const beforeFit = await backend.capture({ ...settings, windowId: null });
    assert.equal(beforeFit.windows[0].id, ownedWindowId, "The owned window must be default before fitting");
    const original = (await browser.call("Browser.getWindowBounds", { windowId })).bounds;
    const fitted = await daemon.fitDisplay({ width: 1000, height: 700 });
    assert.equal(fitted.ok, true, fitted.error);
    const applied = (await browser.call("Browser.getWindowBounds", { windowId })).bounds;
    assert.equal(applied.width, fitted.width); assert.equal(applied.height, fitted.height);
    metrics.fit = fitted;
    await sleep(1200);
    const restored = (await browser.call("Browser.getWindowBounds", { windowId })).bounds;
    assert.deepEqual(restored, original, "Idle restores the exact owned window frame");
    await daemon.fitDisplay({ width: 1100, height: 750 });
    await daemon.stop(); daemon = null;
    assert.deepEqual((await browser.call("Browser.getWindowBounds", { windowId })).bounds, original, "Stop restores the exact owned window frame");
    t.diagnostic("Live metrics " + JSON.stringify(metrics));
    t.diagnostic("Frame artifacts: " + directory);
  } finally {
    await daemon?.stop(); await backend?.stop(); await cache.stop();
    page?.close();
    // Browser.close is sent exclusively to our temporary profile's CDP endpoint.
    try { await browser?.call("Browser.close"); } catch {} browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    t.diagnostic("Artifacts retained at " + directory);
  }
});
