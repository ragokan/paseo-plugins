import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { helperSource } from "./helper-source.ts";

function check(body) {
  const source = helperSource.replace("if __name__ == '__main__':\n    main()", "") + body;
  const result = spawnSync("python3", ["-c", source], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

const imageFixture = `
from types import SimpleNamespace
class Image:
    def __init__(self):
        self.width, self.height, self.stride = 2, 2, 8
        self.pixels = b'abcdefXXghijkl'
        self.encodes = []
    def get_width(self): return self.width
    def get_height(self): return self.height
    def get_rowstride(self): return self.stride
    def get_n_channels(self): return 3
    def get_bits_per_sample(self): return 8
    def get_pixels(self): return self.pixels
    def save_to_bufferv(self, kind, options, values):
        self.encodes.append((kind, options, values))
        return True, b'png' if kind == 'png' else b'jpeg'
`;

test("lossless encoding uses PNG compression 1, with JPEG fallback strictly above the limit", () => {
  check(`
class Encoder:
    def __init__(self, size):
        self.size, self.calls = size, []
    def save_to_bufferv(self, kind, names, values):
        self.calls.append((kind, names, values))
        return True, b'p' * self.size if kind == 'png' else b'jpeg'
assert PNG_LIMIT == 1572864
at_limit = Encoder(10)
assert encode_image(at_limit, 95, True, png_limit=10) == (b'p' * 10, 'image/png')
assert at_limit.calls == [('png', ['compression'], ['1'])]
above = Encoder(11)
assert encode_image(above, 73, True, png_limit=10) == (b'jpeg', 'image/jpeg')
assert above.calls == [('png', ['compression'], ['1']), ('jpeg', ['quality'], ['95'])]
jpeg = Encoder(0)
assert encode_image(jpeg, 70, False) == (b'jpeg', 'image/jpeg')
assert jpeg.calls == [('jpeg', ['quality'], ['70'])]
`);
});

test("pixel hashes ignore row padding and distinguish pixels, dimensions, quality and mode", () => {
  check(imageFixture + `
image = Image()
first = pixel_hash(image, 70, False)
assert pixel_hash(image, 70, False) == first
image.pixels = b'abcdefYYghijkl'
assert pixel_hash(image, 70, False) == first
image.pixels = b'AbcdefYYghijkl'
assert pixel_hash(image, 70, False) != first
image.pixels = b'abcdefYYghijkl'
assert pixel_hash(image, 71, False) != first
assert pixel_hash(image, 70, True) != first
image.width, image.height, image.stride = 1, 4, 4
assert pixel_hash(image, 70, False) != first
`);
});

test("unchanged pixels skip encoding, share cached images and preserve minimized formats", () => {
  check(imageFixture + `
image = Image()
window = dict(id='0x123', title='Fixture', width=2, height=2, focused=True, minimized=False)
d = Desktop.__new__(Desktop)
d.context = SimpleNamespace(iteration=lambda may_block: False)
d.foreign_windows, d.last_frames, d.last_images = {}, {}, {}
d.windows = lambda: [window]
d.attributes = lambda xid: SimpleNamespace(map_state=2)
d.capture_window = lambda *args: image
d.composite_popups = lambda *args: None
clock = [1.0]
time.monotonic = lambda: clock[0]
request = dict(windowId=None, maxWidth=64, maxHeight=64, quality=70)
first = d.frame(request)
assert first['mimeType'] == 'image/jpeg' and first['image']
assert len(image.encodes) == 1
same = d.frame(dict(request, since=first['hash']))
assert len(image.encodes) == 1, image.encodes
assert same['hash'] == first['hash'] and same['image'] is None and not same['changed']
assert d.frame(dict(request, since=first['hash'], includeImage=True))['image'] == first['image']
assert len(image.encodes) == 1, 'Repopulating Node cache must reuse encoded bytes'
image.pixels = b'abcdefZZghijkl'
assert d.frame(request)['hash'] == first['hash']
assert len(image.encodes) == 1
assert d.frame(request)['image'] == first['image'], 'A new viewer must receive the cached image'

motion = d.frame(dict(request, lossless=True, since=first['hash']))
assert motion['mimeType'] == 'image/jpeg' and motion['hash'].endswith('.j')
clock[0] += 0.149
assert d.frame(dict(request, lossless=True, since=motion['hash']))['image'] is None
assert len(image.encodes) == 2
clock[0] += 0.002
png = d.frame(dict(request, lossless=True, since=motion['hash']))
assert png['mimeType'] == 'image/png' and png['image'] and png['hash'] != first['hash']
assert len(image.encodes) == 3
same_png = d.frame(dict(request, lossless=True, since=png['hash']))
assert same_png['image'] is None and same_png['mimeType'] == 'image/png'
assert png['hash'] == motion['hash'][:-1] + 'p'
assert len(image.encodes) == 3
window['minimized'] = True
assert d.frame(dict(request, lossless=True))['image'] == png['image']
assert len(image.encodes) == 3
minimized_motion = d.frame(dict(request, lossless=True, quality=95))
assert minimized_motion['hash'] != png['hash']
assert len(image.encodes) == 4
clock[0] += 0.151
minimized_refined = d.frame(dict(request, lossless=True, quality=95, since=minimized_motion['hash']))
assert minimized_refined['mimeType'] == 'image/png' and minimized_refined['hash'].endswith('.p')
assert len(image.encodes) == 5
window['minimized'] = False
image.pixels = b'AbcdefZZghijkl'
changed = d.frame(dict(request, lossless=True, since=png['hash']))
assert changed['hash'].endswith('.j') and changed['mimeType'] == 'image/jpeg'
assert changed['hash'][:-2] != png['hash'][:-2]
assert len(image.encodes) == 6

d.last_frames.clear()
d.last_images.clear()
window['minimized'] = True
empty = d.frame(dict(request, lossless=True))
assert empty['image'] is None and empty['mimeType'] == 'image/jpeg'
d.windows = lambda: []
missing = d.frame(dict(request, lossless=True))
assert missing['status'] == 'not-running' and missing['mimeType'] == 'image/jpeg'
`);
});

test("tier identity and settle refinement use the latest pixels and never regress a refined tier", () => {
  check(`
assert encoding_tier('abc', True, None, 1.0, 3.0) == 'j'
assert encoding_tier('abc', True, 'abc.j', 1.0, 1.149) == 'j'
assert encoding_tier('abc', True, 'abc.j', 1.0, 1.151) == 'p'
assert encoding_tier('abc', True, 'old.j', 1.0, 3.0) == 'j'
assert encoding_tier('abc', False, 'abc.j', 1.0, 3.0) == 'j'
assert encoding_tier('abc', True, 'abc.p', 1.0, 3.0, refined=True) == 'p'
`);
});

test("XDamage is optional and its events track target and popup damage independently", () => {
  check(`
from types import SimpleNamespace
# Missing library is a supported fallback, not an unsupported desktop.
d = Desktop.__new__(Desktop)
d.x, d.display, d.root = None, None, 1
original = C.CDLL
C.CDLL = lambda name: (_ for _ in ()).throw(OSError('missing'))
d.init_damage()
assert d.damage is None
C.CDLL = original
d.last_frames = {}
assert d.changed(dict(windowId='0x10', maxWidth=800, maxHeight=600, quality=80)) == dict(supported=False, changed=True)

monitor = DamageMonitor.__new__(DamageMonitor)
monitor.display, monitor.event_type = None, 90
monitor.watches, monitor.targets, monitor.dirty = {16: 1, 17: 2, 32: 3}, {16, 17}, set()
events = [(90, 16)]
def next_event(display, pointer):
    kind, window = events.pop(0)
    event = C.cast(pointer, C.POINTER(XEvent)).contents
    event.client.type, event.client.window = kind, window
monitor.x = SimpleNamespace(XPending=lambda display: len(events), XNextEvent=next_event, XFlush=lambda display: None)
subtracted = []
monitor.lib = SimpleNamespace(XDamageSubtract=lambda display, damage, *args: subtracted.append(damage))
assert monitor.changed(16) and not monitor.changed(17)
monitor.captured(16)
assert not monitor.changed(16)
assert subtracted == [1, 3], subtracted
# Popups belong to the browser and can affect any viewer of its windows.
events.append((90, 32))
assert monitor.changed(16) and monitor.changed(17)
monitor.captured(16)
assert monitor.changed(17), 'Capturing one window must not consume another target damage'
monitor.dirty.clear()
events.append((18, 1))
assert monitor.changed(16), 'Root unmap events must remove composited popups'
`);
});
