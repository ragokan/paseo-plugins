import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import contribute from "../index.server.ts";
import { readFrame } from "../shared/contracts.ts";

function decode(image, mimeType, python = "python3") {
  const result = spawnSync(python, ["-c", `
import base64, gi, json, sys
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
loader = GdkPixbuf.PixbufLoader.new_with_mime_type(sys.argv[1])
loader.write(base64.b64decode(sys.stdin.read()))
loader.close()
image = loader.get_pixbuf()
print(json.dumps([image.get_width(), image.get_height()]))
`, mimeType], { input: image, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("live Quality Mode RPC returns a PNG covering the full BrowserOS window", async () => {
  const handlers = new Map();
  const cleanup = contribute({ handle(contract, handler) { handlers.set(contract.name, handler); } });
  try {
    const frame = readFrame.output.parse(await handlers.get("frame.read")({
      windowId: null, maxWidth: 8192, maxHeight: 8192, quality: 95, lossless: true, since: null, waitMs: 0,
    }));
    assert.equal(frame.status, "ready", frame.reason);
    assert.equal(frame.mimeType, "image/png");
    assert.match(frame.image, /^iVBORw0KGgo/);
    assert.ok(Buffer.from(frame.image, "base64").length <= 1_572_864);
    assert.deepEqual([frame.imageWidth, frame.imageHeight], [frame.windowWidth, frame.windowHeight]);
    assert.deepEqual(decode(frame.image, frame.mimeType), [frame.windowWidth, frame.windowHeight]);
  } finally { await cleanup(); }
});

test("near-limit PNG traverses the real JSONL pipe and registered RPC; oversized PNG falls back", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "browseros-quality-rpc-"));
  const executable = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(executable.status, 0, executable.stderr);
  const python = executable.stdout.trim();
  // The wrapper runs the production helper and supplies deterministic noisy pixbufs.
  // It neither opens nor changes any desktop window.
  await writeFile(join(folder, "python3"), `#!${python}
import sys
namespace = {'__name__': 'quality_fixture'}
exec(compile(sys.argv[3], '<production-helper>', 'exec'), namespace)
def initialize(self):
    import gi, random
    from types import SimpleNamespace
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import GdkPixbuf, GLib
    self.context = GLib.MainContext.default()
    self.foreign_windows, self.last_frames, self.last_images = {}, {}, {}
    self.Pixbuf = GdkPixbuf
    self.pictures = {}
    for xid, height in ((0xf000, 500), (0xf001, 600)):
        pixels = random.Random(xid).randbytes(1024 * height * 3)
        self.pictures[xid] = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(pixels),
            GdkPixbuf.Colorspace.RGB, False, 8, 1024, height, 3072)
    self.windows = lambda: [dict(id=hex(xid), title='Noise fixture', width=1024, height=height,
        focused=False, minimized=False) for xid, height in ((0xf001, 600), (0xf000, 500))]
    self.attributes = lambda xid: SimpleNamespace(map_state=2)
    self.capture_window = lambda xid, width, height: self.pictures[xid]
    self.composite_popups = lambda *args: None
    self.release_input = lambda: None
namespace['Desktop'].__init__ = initialize
original_encode = namespace['encode_image']
encoded = set()
def once(image, quality, lossless, *args, **kwargs):
    key = (image.get_width(), image.get_height(), quality, lossless)
    if key in encoded:
        raise RuntimeError('Unchanged pixels were encoded more than once')
    encoded.add(key)
    return original_encode(image, quality, lossless, *args, **kwargs)
namespace['encode_image'] = once
namespace['main']()
`, { mode: 0o755 });
  const pathBefore = process.env.PATH;
  process.env.PATH = `${folder}:${pathBefore ?? ""}`;
  const handlers = new Map();
  const cleanup = contribute({ handle(contract, handler) { handlers.set(contract.name, handler); } });
  try {
    const input = { windowId: "0xf000", maxWidth: 8192, maxHeight: 8192, quality: 95, lossless: true, since: null, waitMs: 0 };
    const read = async (value) => readFrame.output.parse(await handlers.get("frame.read")(value));
    const first = await read(input);
    assert.equal(first.status, "ready", first.reason);
    assert.equal(first.mimeType, "image/png");
    assert.match(first.image, /^iVBORw0KGgo/);
    assert.ok(first.image.length > 2_000_000, `Expected a near-limit PNG, got ${first.image.length} base64 characters`);
    assert.ok(first.image.length <= 2_097_152);
    // Decode with the real interpreter, rather than the transport fixture wrapper.
    assert.deepEqual(decode(first.image, first.mimeType, python), [1024, 500]);
    t.diagnostic(`PNG payload: ${Buffer.from(first.image, "base64").length} bytes, ${first.image.length} base64 characters; no truncation.`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const same = await read({ ...input, since: first.hash });
    assert.equal(same.status, "ready", same.reason);
    assert.equal(same.mimeType, "image/png");
    assert.equal(same.changed, false);
    assert.equal(same.image, null);
    const newcomer = await read(input);
    assert.equal(newcomer.changed, true);
    assert.equal(newcomer.image, first.image);
    const fallback = await read({ ...input, windowId: "0xf001" });
    assert.equal(fallback.status, "ready", fallback.reason);
    assert.equal(fallback.mimeType, "image/jpeg");
    assert.match(fallback.image, /^\/9j\//);
    assert.deepEqual(decode(fallback.image, fallback.mimeType, python), [1024, 600]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const sameFallback = await read({ ...input, windowId: "0xf001", since: fallback.hash });
    assert.equal(sameFallback.status, "ready", sameFallback.reason);
    assert.equal(sameFallback.mimeType, "image/jpeg");
    assert.equal(sameFallback.image, null);
    const lossy = await read({ ...input, windowId: "0xf001", lossless: false, since: fallback.hash });
    assert.equal(lossy.changed, true);
    assert.notEqual(lossy.hash, fallback.hash, "Changing modes must change the hash even when both encode as JPEG");
    assert.equal(lossy.image, fallback.image);
  } finally {
    try { await cleanup(); }
    finally {
      if (pathBefore === undefined) delete process.env.PATH;
      else process.env.PATH = pathBefore;
      await rm(folder, { recursive: true, force: true });
    }
  }
});
