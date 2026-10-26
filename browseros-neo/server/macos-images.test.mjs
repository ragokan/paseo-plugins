import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopHelper } from "./helper.ts";
import { MacHelperCache, preparing } from "./macos-helper.ts";
import { macHelperSource } from "./macos-source.ts";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function replaceFunction(source, start, end, body) {
  assert.ok(source.includes(start) && source.includes(end));
  return source.slice(0, source.indexOf(start)) + body + source.slice(source.indexOf(end, source.indexOf(start)));
}

// Substitute only the OS boundaries; exercise the production hash, image codecs,
// frame cache and JSONL pipe without permissions, windows or desktop side effects.
test("native frames hash raw pixels, refine once, bound size and fall back above the PNG limit", {
  skip: process.platform !== "darwin", timeout: 180000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "browseros-mac-images-"));
  let source = replaceFunction(macHelperSource, "    private func permissions()", "    func windows()", "    private func permissions() -> String? { nil }\n");
  source = source.replace("import Darwin", "import Darwin\nvar fixtureMinimized = false");
  // Move the request timestamp back; the real timer and thirty-second condition run unchanged.
  source = source.replace('        if method == "frame"', '        if method == "fixture-expire" { lastRequest -= 31; return ["ok": true] }\n        if method == "frame"');
  source = source.replace('        if method == "frame"', '        if method == "fixture-minimize" { fixtureMinimized = true; return ["ok": true] }\n        if method == "frame"');
  source = replaceFunction(source, "    func windows()", "    private func selected(", `
    func windows() -> [BrowserWindow] {
        [BrowserWindow(id: 42, app: NSRunningApplication.current, title: "Image fixture - BrowserOS neo", frame: CGRect(x: 0, y: 0, width: 1200, height: 900), minimized: fixtureMinimized, focused: true)]
    }
`);
  source = replaceFunction(source, "    private func captureImage(", "    private func configuration(", `
    private func captureImage(_ target: BrowserWindow, _ params: [String: Any]) async throws -> CGImage? {
        let size = fitPixels(1200, 900, Double(number(params, "maxWidth")), Double(number(params, "maxHeight")))
        let width = Int(size.width), height = Int(size.height)
        let canvas = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        let bytes = canvas.data!.assumingMemoryBound(to: UInt8.self)
        var random: UInt32 = 1234567
        let noise = params["noise"] as? Bool ?? false
        for index in 0..<(width * height * 4) {
            random ^= random << 13; random ^= random >> 17; random ^= random << 5
            bytes[index] = index % 4 == 3 ? 255 : noise ? UInt8(truncatingIfNeeded: random) : UInt8(number(params, "shade", 100))
        }
        return canvas.makeImage()
    }
`);
  const cache = new MacHelperCache({ root: directory, source });
  let helper;
  try {
    let state;
    do { state = cache.prepare(); if (state.reason === preparing) await sleep(20); } while (state.reason === preparing);
    assert.ok(state.binary, state.reason);
    helper = new DesktopHelper(0, { executable: state.binary, args: [] });
    const settings = { windowId: "0x2a", maxWidth: 800, maxHeight: 600, quality: 80, lossless: true, since: null };
    const frame = input => helper.request("frame", { ...settings, ...input });
    const first = await frame();
    assert.equal(first.windows[0].title, "Image fixture");
    assert.equal(first.windowWidth, 1200); assert.equal(first.windowHeight, 900);
    assert.equal(first.imageWidth, 800); assert.equal(first.imageHeight, 600);
    assert.equal(first.mimeType, "image/jpeg"); assert.ok(first.hash.endsWith(".j"));
    assert.equal(Buffer.from(first.image, "base64").subarray(0, 2).toString("hex"), "ffd8");
    await sleep(170);
    const refined = await frame({ since: first.hash });
    assert.equal(refined.mimeType, "image/png"); assert.equal(refined.hash, first.hash.slice(0,-2) + ".p");
    assert.equal(Buffer.from(refined.image, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal((await frame({ since: refined.hash })).image, null);
    assert.equal((await frame({ since: refined.hash, includeImage: true })).image, refined.image);
    assert.equal((await frame()).hash, refined.hash, "New viewers share an existing refinement");
    const motion = await frame({ since: refined.hash, shade: 200 });
    assert.notEqual(motion.hash.slice(0,-2), refined.hash.slice(0,-2)); assert.ok(motion.hash.endsWith(".j"));
    const quality = await frame({ quality: 95 });
    assert.notEqual(quality.hash.slice(0,-2), first.hash.slice(0,-2));
    const noise = await frame({ maxWidth: 1200, maxHeight: 900, noise: true });
    await sleep(170);
    const fallback = await frame({ maxWidth: 1200, maxHeight: 900, noise: true, since: noise.hash });
    assert.ok(fallback.hash.endsWith(".p")); assert.equal(fallback.mimeType, "image/jpeg");
    assert.equal(Buffer.from(fallback.image, "base64").subarray(0, 2).toString("hex"), "ffd8");
    assert.equal((await frame({ maxWidth: 2000, maxHeight: 2000 })).imageWidth, 1200, "Never upscale");
    const idle = await frame({ quality: 61 });
    await sleep(170);
    const idleSharp = await frame({ quality: 61, since: idle.hash });
    assert.ok(idleSharp.hash.endsWith(".p"));
    await helper.request("fixture-expire", {});
    await sleep(1250);
    assert.ok((await frame({ quality: 61, since: idleSharp.hash })).hash.endsWith(".j"), "Idle releases the encoded image cache");
    await helper.request("fixture-minimize", {});
    const minimized = await frame({ maxWidth: 64, maxHeight: 64 });
    assert.equal(minimized.imageWidth, 64, "A retained minimized image still respects the requested bounds");
    assert.equal(minimized.imageHeight, 48);
  } finally { await helper?.stop(); await cache.stop(); await rm(directory, { recursive: true, force: true }); }
});
