import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserDaemon } from "./daemon.ts";
import { DesktopHelper, desktopEnvironment } from "./helper.ts";
import { helperSource } from "./helper-source.ts";

// Opt in because this briefly brings a newly created window onto the user's desktop.
test("live input types into and closes only its own BrowserOS window", {
  skip: process.env.PASEO_BROWSEROS_INPUT_TEST !== "1",
}, async (t) => {
  const daemon = new BrowserDaemon();
  const settings = { windowId: null, maxWidth: 1400, maxHeight: 1000, quality: 85, since: null, waitMs: 0 };
  let ownedId = null;
  const page = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><title>Input fixture</title><body style="margin:0;height:5000px;background:#efe">'
      + '<script>const state={};const record=(k,v)=>{state[k]=v;document.title=JSON.stringify(state)};'
      + 'onmousemove=()=>record("moved",true);onmousedown=e=>record("down",e.button);'
      + 'onmouseup=e=>record("up",e.button);onclick=e=>record("click",e.detail);'
      + 'onscroll=()=>record("scroll",scrollY);</script>');
  });
  const key = (key, modifiers = []) => ({ type: "key", key, modifiers });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const before = await daemon.readFrame(settings);
    assert.equal(before.status, "ready", before.reason);
    const existingIds = new Set(before.windows.map((w) => w.id));
    await new Promise((resolve, reject) => {
      const child = spawn("browserclaw", ["--new-window", "about:blank"], {
        env: desktopEnvironment(), stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Launcher exited ${code}`)));
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(100);
      const windows = (await daemon.readFrame(settings)).windows.filter((w) => !existingIds.has(w.id));
      if (windows.length === 1) { ownedId = windows[0].id; break; }
      assert.ok(windows.length < 2, "More than one new window appeared; refusing ambiguous input");
    }
    assert.ok(ownedId, "The new blank BrowserOS window did not appear");
    const owned = { ...settings, windowId: ownedId };
    assert.equal((await daemon.launchBrowser()).ok, true);
    await sleep(300);
    const baseline = await daemon.readFrame(owned);
    const result = await daemon.sendInput({ windowId: ownedId, events: [key("l", ["ctrl"]), { type: "text", text: "paseo-test" }] });
    assert.equal(result.ok, true, result.error);
    await sleep(150);
    const typed = await daemon.readFrame(owned);
    assert.notEqual(typed.hash, baseline.hash);
    const asciiPath = join(tmpdir(), "browseros-neo-input-ascii.jpg");
    await writeFile(asciiPath, Buffer.from(typed.image, "base64"));
    t.diagnostic(`Typed ASCII frame: ${asciiPath}`);
    const probeSource = helperSource.replace("if __name__ == '__main__':\n    main()", "") + `
d = Desktop()
captured = []
original_capture = d.capture_window
def record_capture(window, width, height):
    image = original_capture(window, width, height)
    if image is not None:
        captured.append(hex(window))
    return image
d.capture_window = record_capture
d.frame(json.loads(sys.argv[1]))
children = []
for child in d.tree(d.root)[1]:
    attrs = d.attributes(child)
    if attrs and attrs.map_state == 2:
        children.append(dict(id=hex(child), override=bool(attrs.override_redirect),
            pid=d.pid(child), wmclass=[v.decode('utf-8', 'replace') for v in d.wm_class(child)],
            title=d.title(child)))
print(json.dumps(dict(captured=captured, children=children)))
`;
    const popupProbe = spawnSync("python3", ["-c", probeSource, JSON.stringify(owned)], {
      env: desktopEnvironment(), encoding: "utf8",
    });
    assert.equal(popupProbe.status, 0, popupProbe.stderr);
    const { captured, children } = JSON.parse(popupProbe.stdout);
    assert.ok(captured.includes(ownedId));
    t.diagnostic(`Omnibox X11 probe: ${JSON.stringify({ captured, children })}`);

    const unicode = await daemon.sendInput({ windowId: ownedId, events: [key("l", ["ctrl"]), { type: "text", text: "Paseo / é 漢 😀" }] });
    assert.equal(unicode.ok, true, unicode.error);
    await sleep(150);
    const unicodeFrame = await daemon.readFrame(owned);
    assert.notEqual(unicodeFrame.hash, typed.hash);
    const unicodePath = join(tmpdir(), "browseros-neo-input-unicode.jpg");
    await writeFile(unicodePath, Buffer.from(unicodeFrame.image, "base64"));
    t.diagnostic(`Typed Unicode frame: ${unicodePath}`);
    const motion = await daemon.readFrame({ ...owned, lossless: true });
    const losslessFrame = await daemon.readFrame({ ...owned, lossless: true, since: motion.hash, waitMs: 1000 });
    assert.equal(losslessFrame.mimeType, "image/png");
    assert.match(losslessFrame.image, /^iVBORw0KGgo/);

    const minimizeSource = helperSource.replace("if __name__ == '__main__':\n    main()", "") + `
d = Desktop()
d.bind(d.x, 'XIconifyWindow', C.c_int, [C.c_void_p, C.c_ulong, C.c_int])
d.x.XIconifyWindow(d.display, int(sys.argv[1], 16), 0)
d.x.XSync(d.display, 0)
`;
    const minimize = spawnSync("python3", ["-c", minimizeSource, ownedId], { env: desktopEnvironment(), encoding: "utf8" });
    assert.equal(minimize.status, 0, minimize.stderr);
    await sleep(200);
    const minimized = await daemon.readFrame({ ...owned, since: unicodeFrame.hash });
    assert.equal(minimized.windows.find((w) => w.id === ownedId).minimized, true);
    assert.equal(minimized.hash, unicodeFrame.hash);
    assert.equal(minimized.changed, false);
    assert.equal(minimized.image, null);
    const minimizedPng = await daemon.readFrame({ ...owned, lossless: true, since: losslessFrame.hash });
    assert.equal(minimizedPng.mimeType, "image/png");
    assert.equal(minimizedPng.hash, losslessFrame.hash);
    assert.equal(minimizedPng.image, null);
    const resized = await daemon.readFrame({ ...owned, maxWidth: 900 });
    assert.ok(resized.image && resized.imageWidth <= 900);
    const resizedMotion = await daemon.readFrame({ ...owned, lossless: true, maxWidth: 900 });
    const resizedPng = await daemon.readFrame({ ...owned, lossless: true, maxWidth: 900, since: resizedMotion.hash, waitMs: 1000 });
    assert.equal(resizedPng.mimeType, "image/png");
    assert.ok(resizedPng.image && resizedPng.imageWidth <= 900);
    const cold = new DesktopHelper();
    try {
      const uncached = await cold.request("frame", owned);
      assert.equal(uncached.status, "ready");
      assert.equal(uncached.image, null);
      assert.equal(uncached.changed, false);
      assert.equal(uncached.mimeType, "image/jpeg");
    } finally { await cold.stop(); }
    t.diagnostic("Minimized window returns cached images at both sizes, or null without a cache.");

    await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${page.address().port}/`;
    assert.equal((await daemon.sendInput({ windowId: ownedId, events: [key("Escape"), key("l", ["ctrl"]), { type: "text", text: url }, key("Enter")] })).ok, true);
    await sleep(250);
    const title = async () => (await daemon.readFrame(owned)).windows.find((w) => w.id === ownedId)?.title;
    const state = async () => { const value = await title(); return value === "Input fixture" ? {} : JSON.parse(value); };
    const fixtureFrame = await daemon.readFrame(owned);
    await writeFile(join(tmpdir(), "browseros-neo-input-fixture.jpg"), Buffer.from(fixtureFrame.image, "base64"));
    const point = { x: baseline.windowWidth * 0.6, y: baseline.windowHeight * 0.6 };
    const send = async (event) => {
      const result = await daemon.sendInput({ windowId: ownedId, events: [event] });
      assert.equal(result.ok, true, result.error);
      await sleep(80);
    };
    const awaitState = async (predicate) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const value = await state();
        if (predicate(value)) return value;
        await sleep(80);
      }
      assert.fail(`Page events did not reach the expected state: ${JSON.stringify(await state())}`);
    };
    await send({ type: "move", x: point.x - 50, y: point.y });
    await send({ type: "move", ...point });
    await awaitState((value) => value.moved);
    await send({ type: "down", ...point, button: "left" });
    await send({ type: "up", ...point, button: "left" });
    await awaitState((value) => value.down === 0 && value.up === 0 && value.click === 1);
    await sleep(600);
    await send({ type: "click", ...point, button: "left", count: 2 });
    await awaitState((value) => value.click === 2);
    await send({ type: "scroll", ...point, dx: 0, dy: 3 });
    await awaitState((value) => value.scroll > 0);
    t.diagnostic("Verified pointer movement, down/up across batches, double click and scrolling via page events.");
    const temporary = new BrowserDaemon();
    try {
      assert.equal((await temporary.sendInput({ windowId: ownedId, events: [{ type: "down", ...point, button: "left" }] })).ok, true);
    } finally { await temporary.stop(); }
    const queryPointerSource = helperSource.replace("if __name__ == '__main__':\n    main()", "") + `
d = Desktop()
d.bind(d.x, 'XQueryPointer', C.c_int, [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_uint)])
root, child = C.c_ulong(), C.c_ulong()
x, y, wx, wy = C.c_int(), C.c_int(), C.c_int(), C.c_int()
mask = C.c_uint()
d.x.XQueryPointer(d.display, d.root, C.byref(root), C.byref(child), C.byref(x), C.byref(y), C.byref(wx), C.byref(wy), C.byref(mask))
print(mask.value)
`;
    const pointer = spawnSync("python3", ["-c", queryPointerSource], { env: desktopEnvironment(), encoding: "utf8" });
    assert.equal(pointer.status, 0, pointer.stderr);
    assert.equal(Number(pointer.stdout.trim()) & 256, 0, "Stopping the helper must release its held mouse button");
    await send(key("ContextMenu"));
    const menuProbe = spawnSync("python3", ["-c", probeSource, JSON.stringify(owned)], {
      env: desktopEnvironment(), encoding: "utf8",
    });
    assert.equal(menuProbe.status, 0, menuProbe.stderr);
    const menu = JSON.parse(menuProbe.stdout);
    t.diagnostic(`Context menu X11 probe: ${JSON.stringify(menu)}`);
    assert.ok(menu.captured.length > 1, "The context menu must be captured separately and composited");
    const menuFrame = await daemon.readFrame(owned);
    const menuPath = join(tmpdir(), "browseros-neo-context-menu.jpg");
    await writeFile(menuPath, Buffer.from(menuFrame.image, "base64"));
    t.diagnostic(`Context menu frame: ${menuPath}`);
    assert.equal((await daemon.sendInput({ windowId: ownedId, events: [key("Escape"), key("w", ["ctrl"])] })).ok, true);
    await sleep(250);
    const after = await daemon.readFrame(settings);
    assert.ok(!after.windows.some((w) => w.id === ownedId), "The test window was not closed");
    assert.ok([...existingIds].every((id) => after.windows.some((w) => w.id === id)), "An original window disappeared");
    ownedId = null;
  } finally {
    if (ownedId) {
      const owned = (await daemon.readFrame({ ...settings, windowId: ownedId })).windows.find((w) => w.id === ownedId);
      if (owned) await daemon.sendInput({ windowId: ownedId, events: [
        { type: "up", x: owned.width / 2, y: owned.height / 2, button: "left" },
        key("Escape"), key("w", ["ctrl"]),
      ] });
    }
    await new Promise((resolve) => page.close(resolve));
    await daemon.stop();
  }
});
