import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import contribute from "../index.server.ts";
import { fitDisplay, readFrame } from "../shared/contracts.ts";
import { DisplayFitter, parseXrandr, runXrandr } from "./display.ts";
import { DesktopHelper } from "./helper.ts";

// Opt in: this changes the real virtual desktop, including the RustDesk view.
test("live display fit resizes the maximized BrowserOS window and restores the screen", {
  skip: process.env.PASEO_BROWSEROS_DISPLAY_TEST !== "1",
}, async (t) => {
  const helper = new DesktopHelper();
  const handlers = new Map();
  const cleanup = contribute({ handle(contract, handler) { handlers.set(contract.name, handler); } });
  let cleaned = false;
  let output;
  try {
    const initial = parseXrandr(await runXrandr(["--query"]));
    output = initial.outputs.find((item) => item.primary) ?? initial.outputs[0];
    assert.match(output.name, /^(DUMMY|VIRTUAL|VNC|XVFB)/i);
    assert.deepEqual(initial.screen, { width: 1920, height: 1080 }, "This live check starts and ends at 1920x1080");
    const before = await helper.request("display", {});
    const result = fitDisplay.output.parse(await handlers.get("display.fit")({ width: 1280, height: 720 }));
    assert.deepEqual(result, { ok: true, width: 1280, height: 720, error: null });
    let desktop;
    let frame;
    for (let attempt = 0; attempt < 30; attempt++) {
      desktop = await helper.request("display", {});
      frame = readFrame.output.parse(await handlers.get("frame.read")({
        windowId: null, maxWidth: 1280, maxHeight: 720, quality: 70, since: null, waitMs: 0,
      }));
      if (desktop.workarea.width === 1280 && desktop.workarea.height === 720 && frame.windowWidth === 1280 && frame.windowHeight === 720) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(frame.status, "ready", frame.reason);
    assert.deepEqual({ width: frame.windowWidth, height: frame.windowHeight }, { width: 1280, height: 720 });
    assert.deepEqual({ width: desktop.workarea.width, height: desktop.workarea.height }, { width: 1280, height: 720 });
    assert.deepEqual({ width: desktop.screenWidth, height: desktop.screenHeight }, { width: 1360, height: 752 });
    assert.match(frame.image, /^\/9j\//);
    t.diagnostic(`Fitted ${output.name}: screen 1360x752, work area and BrowserOS 1280x720.`);

    await cleanup();
    cleaned = true;
    const restored = parseXrandr(await runXrandr(["--query"]));
    assert.deepEqual(restored.screen, initial.screen);
    assert.equal(restored.outputs.find((item) => item.name === output.name).mode, output.mode);
    assert.deepEqual([...restored.modes].sort(), [...initial.modes].sort(), "Cleanup must remove all modes this test created");
    for (let attempt = 0; attempt < 30; attempt++) {
      desktop = await helper.request("display", {});
      if (desktop.workarea.width === before.workarea.width && desktop.workarea.height === before.workarea.height) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(desktop, before);
    t.diagnostic("Cleanup restored 1920x1080, the original work area, and the original mode list.");
  } finally {
    try {
      if (!cleaned) await cleanup();
    } finally {
      try {
        // Independent fallback also runs when an assertion or cleanup fails.
        if (output && /^(DUMMY|VIRTUAL|VNC|XVFB)/i.test(output.name)) {
          await runXrandr(["--output", output.name, "--mode", "1920x1080"]);
        }
      } finally { await helper.stop(); }
    }
  }
});

function bottomRows(image) {
  const result = spawnSync("python3", ["-c", `
import base64, gi, json, sys
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
loader = GdkPixbuf.PixbufLoader.new_with_mime_type('image/jpeg')
loader.write(base64.b64decode(sys.stdin.read()))
loader.close()
image = loader.get_pixbuf()
width, height = image.get_width(), image.get_height()
pixels, stride, channels = image.get_pixels(), image.get_rowstride(), image.get_n_channels()
nonblack = 0
rows = min(64, height)
for y in range(height - rows, height):
    for x in range(width):
        offset = y * stride + x * channels
        if max(pixels[offset:offset + 3]) > 12:
            nonblack += 1
print(json.dumps(dict(width=width, height=height, nonBlackFraction=nonblack / (width * rows))))
`], { input: image, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("live long-lived capture follows a taller phone resize without black bottom rows", {
  skip: process.env.PASEO_BROWSEROS_DISPLAY_TEST !== "1",
}, async (t) => {
  const helper = new DesktopHelper();
  const fresh = new DesktopHelper();
  const display = new DisplayFitter({ readDesktop: () => helper.request("display", {}) });
  let output;
  try {
    const initial = parseXrandr(await runXrandr(["--query"]));
    output = initial.outputs.find((item) => item.primary) ?? initial.outputs[0];
    assert.match(output.name, /^(DUMMY|VIRTUAL|VNC|XVFB)/i);
    assert.deepEqual(initial.screen, { width: 1920, height: 1080 });
    const settings = { windowId: null, maxWidth: 4096, maxHeight: 4096, quality: 85 };
    const before = await helper.request("frame", settings);
    assert.equal(before.status, "ready", before.reason);
    assert.deepEqual([before.windowWidth, before.windowHeight], [1840, 1048]);
    const processId = helper.child.pid;
    assert.deepEqual(await display.fit({ width: 388, height: 700 }), {
      ok: true, width: 800, height: 1440, error: null,
    });
    const selected = { ...settings, windowId: before.windowId };
    let frame;
    for (let attempt = 0; attempt < 30; attempt++) {
      frame = await helper.request("frame", selected);
      if (frame.windowWidth === 800 && frame.windowHeight === 1440 && frame.imageWidth === 800 && frame.imageHeight === 1440) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Let Chromium paint the newly exposed area before comparing the two processes.
    await new Promise((resolve) => setTimeout(resolve, 300));
    frame = await helper.request("frame", selected);
    const reference = await fresh.request("frame", selected);
    assert.equal(helper.child.pid, processId, "The original capture process must stay alive across the resize");
    assert.deepEqual([frame.windowWidth, frame.windowHeight, frame.imageWidth, frame.imageHeight], [800, 1440, 800, 1440]);
    assert.deepEqual([reference.imageWidth, reference.imageHeight], [800, 1440]);
    const expected = bottomRows(reference.image);
    const streamed = bottomRows(frame.image);
    t.diagnostic(`Bottom 64 rows: fresh process ${expected.nonBlackFraction}, existing process ${streamed.nonBlackFraction} nonblack.`);
    assert.ok(expected.nonBlackFraction > 0.02, "The fresh capture must prove the browser's bottom rows contain visible pixels");
    assert.ok(streamed.nonBlackFraction > 0.02, "The long-lived helper must capture the new bottom rows, not black padding");
    assert.ok(Math.abs(streamed.nonBlackFraction - expected.nonBlackFraction) < 0.1);
  } finally {
    try {
      const restored = await display.stop();
      assert.equal(restored.ok, true, restored.error);
    } finally {
      try {
        if (output && /^(DUMMY|VIRTUAL|VNC|XVFB)/i.test(output.name)) {
          await runXrandr(["--output", output.name, "--mode", "1920x1080"]);
          assert.deepEqual(parseXrandr(await runXrandr(["--query"])).screen, { width: 1920, height: 1080 });
        }
      } finally { await Promise.all([helper.stop(), fresh.stop()]); }
    }
  }
});
