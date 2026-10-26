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
test("native window discovery excludes Chromium surfaces, retains minimized windows and survives transient AX failures", {
  skip: process.platform !== "darwin", timeout: 180000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "browseros-mac-windows-"));
  let source = replace(macHelperSource, "func attribute(", "struct BrowserWindow", `
var fixtureAlive = true
var fixtureAX = true
var fixtureMinimized = false
var fixtureDuplicate = false
var fixtureDifferentTitles = false
var fixtureTwinMinimized = false
var fixtureFrame = CGRect(x: 120, y: 140, width: 1200, height: 900)
let fixtureMain = AXUIElementCreateApplication(100042)
let fixtureTwin = AXUIElementCreateApplication(100043)
let fixtureUtility = AXUIElementCreateApplication(100100)
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    if key == kAXWindowsAttribute { return ((fixtureAlive && fixtureAX ? [fixtureMain] + (fixtureDuplicate ? [fixtureTwin] : []) : []) + [fixtureUtility]) as CFArray }
    let main = CFEqual(element, fixtureMain) || CFEqual(element, fixtureTwin)
    if key == kAXTitleAttribute { return (main ? (CFEqual(element, fixtureTwin) && fixtureDifferentTitles ? "Second window" : "Fixture main") : "Utility") as CFString }
    if key == kAXRoleAttribute { return kAXWindowRole as CFString }
    if key == kAXSubroleAttribute { return (main ? kAXStandardWindowSubrole : "AXUnknown") as CFString }
    if key == kAXMinimizedAttribute { return main && (CFEqual(element, fixtureTwin) ? fixtureTwinMinimized : fixtureMinimized) ? kCFBooleanTrue : kCFBooleanFalse }
    return nil
}
func axFrame(_ element: AXUIElement) -> CGRect? {
    CFEqual(element, fixtureUtility) ? CGRect(x: 0, y: 940, width: 500, height: 500) : fixtureFrame
}
func setFrame(_ element: AXUIElement, _ frame: CGRect) throws { fixtureFrame = frame }
`);
  source = replace(source, "func windowInfo()", "func matchingAX(", `
func windowInfo() -> [[String: Any]]? {
    var rows: [(Int, CGRect, String)] = [(100, CGRect(x: 0, y: 940, width: 500, height: 500), "Utility"), (101, CGRect(x: 0, y: 0, width: 2560, height: 30), ""), (102, CGRect(x: 0, y: 0, width: 1, height: 1), "")]
    if fixtureAlive {
        rows.append((42, fixtureFrame, "Fixture main"))
        if fixtureDuplicate {
            rows.append((43, fixtureFrame, fixtureDifferentTitles ? "Second window" : "Fixture main"))
            if !fixtureDifferentTitles { rows.append((103, CGRect(x: 0, y: 0, width: 2560, height: 30), "Fixture main")) }
        }
    }
    return rows.map { [kCGWindowNumber as String: $0.0, kCGWindowOwnerPID as String: Int(getpid()), kCGWindowLayer as String: 0, kCGWindowName as String: $0.2, kCGWindowBounds as String: $0.1.dictionaryRepresentation] }
}
`);
  source = source.replace("NSWorkspace.shared.runningApplications.filter(isBrowser)", "[NSRunningApplication.current]");
  source = replace(source, "    private func permissions()", "    func windows()", "    private func permissions() -> String? { nil }\n");
  source = replace(source, "    private func captureImage(", "    private func configuration(", `
    private func captureImage(_ target: BrowserWindow, _ params: [String: Any]) async throws -> CGImage? {
        let canvas = CGContext(data: nil, width: 320, height: 240, bitsPerComponent: 8, bytesPerRow: 1280, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        canvas.setFillColor(CGColor(gray: 0.5, alpha: 1)); canvas.fill(CGRect(x: 0, y: 0, width: 320, height: 240))
        return canvas.makeImage()
    }
`);
  source = source.replace('        if method == "frame"', `        if method == "fixture-config" {
            if let value = params["alive"] as? Bool { fixtureAlive = value }
            if let value = params["ax"] as? Bool { fixtureAX = value }
            if let value = params["minimized"] as? Bool { fixtureMinimized = value }
            if let value = params["duplicate"] as? Bool { fixtureDuplicate = value }
            if let value = params["differentTitles"] as? Bool { fixtureDifferentTitles = value }
            if let value = params["twinMinimized"] as? Bool { fixtureTwinMinimized = value }
            return ["ok": true]
        }
        if method == "fixture-state" { return ["originals": originals.count, "width": Int(fixtureFrame.width), "height": Int(fixtureFrame.height)] }
        if method == "fixture-exact" { return ["found": matchingAX(try selected("0x2a")) != nil] }
        if method == "fixture-selected" { return try selected(params["id"] as? String ?? "").json }
        if method == "frame"`);
  const cache = new MacHelperCache({ root, source }); let helper;
  try {
    let state;
    do { state = cache.prepare(); if (state.reason === preparing) await new Promise(resolve => setTimeout(resolve, 10)); } while (state.reason === preparing);
    assert.ok(state.binary, state.reason);
    helper = new DesktopHelper(0, { executable: state.binary, args: [] });
    const frame = () => helper.request("frame", { windowId: null, maxWidth: 640, maxHeight: 480, quality: 70, lossless: false, since: null });
    const configure = input => helper.request("fixture-config", input);
    let result = await frame();
    assert.deepEqual(result.windows.map(w => w.id), ["0x2a"]);
    await assert.rejects(helper.request("fixture-selected", { id: "0x64" }), /window/i);
    await configure({ minimized: true }); result = await frame();
    assert.equal(result.windowId, "0x2a"); assert.equal(result.windows[0].minimized, true); assert.ok(result.image);
    await assert.rejects(helper.request("fit", { width: 1000, height: 700 }), /window/i);
    await configure({ minimized: false });
    await helper.request("fit", { width: 1000, height: 700 });
    await configure({ ax: false });
    await assert.rejects(helper.request("restore", {}), /retained/i);
    assert.equal((await helper.request("fixture-state", {})).originals, 1);
    await configure({ ax: true }); await helper.request("restore", {});
    assert.deepEqual(await helper.request("fixture-state", {}), { originals: 0, width: 1200, height: 900 });
    await configure({ alive: false, ax: false }); result = await frame();
    assert.equal(result.status, "not-running"); assert.deepEqual(result.windows, []); assert.equal(result.image, null);
    await configure({ alive: true, ax: true }); result = await frame();
    assert.equal(result.status, "ready"); assert.equal(result.windowId, "0x2a"); assert.ok(result.image);
    await configure({ duplicate: true }); result = await frame();
    assert.deepEqual(result.windows.map(w => w.id), ["0x2a", "0x2b"], "Ambiguous standard windows remain capturable");
    assert.equal((await helper.request("fixture-exact", {})).found, false, "Input still requires an unambiguous exact AX window");
    await configure({ differentTitles: true, twinMinimized: true }); result = await frame();
    assert.equal(result.windows.find(w => w.id === "0x2a").minimized, false);
    assert.equal(result.windows.find(w => w.id === "0x2b").minimized, true, "Titles disambiguate minimized state when bounds match");
    assert.equal((await helper.request("fixture-exact", {})).found, true);
  } finally { await helper?.stop(); await cache.stop(); await rm(root, { recursive: true, force: true }); }
});
