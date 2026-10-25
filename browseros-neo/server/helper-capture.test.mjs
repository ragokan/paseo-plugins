import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { helperSource } from "./helper-source.ts";

function check(body) {
  const source = helperSource.replace("if __name__ == '__main__':\n    main()", "") + body;
  const result = spawnSync("python3", ["-c", source], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test("GLib pumping stays non-blocking and bounded even when events remain ready", () => {
  check(`
from types import SimpleNamespace
calls = []
d = Desktop.__new__(Desktop)
def iteration(may_block):
    calls.append(may_block)
    return True
d.context = SimpleNamespace(iteration=iteration)
d.pump_events()
assert 0 < len(calls) <= 64, calls
assert not any(calls), calls
`);
});

test("foreign captures subscribe once per target or popup and clip stale geometry safely", () => {
  check(`
from types import SimpleNamespace
class Native:
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.masks = []
    def get_width(self): return self.width
    def get_height(self): return self.height
    def is_destroyed(self): return False
    def get_events(self): return 8
    def set_events(self, mask): self.masks.append(mask)
    def destroy(self): raise AssertionError('A foreign window must never be destroyed')

target, popup = Native(80, 60), Native(25, 35)
windows = {1: target, 2: popup}
attrs = {1: SimpleNamespace(width=100, height=120), 2: SimpleNamespace(width=50, height=60)}
wrapped, captures, traps = [], [], []
def wrap(display, xid):
    wrapped.append(xid)
    return windows[xid]
def capture(native, x, y, width, height):
    captures.append((width, height))
    return width, height

d = Desktop.__new__(Desktop)
d.context = SimpleNamespace(iteration=lambda may_block: False)
d.foreign_windows = {}
d.gdk = SimpleNamespace(error_trap_push=lambda: traps.append('push'),
    error_trap_pop_ignored=lambda: traps.append('pop'), flush=lambda: None)
d.Gdk = SimpleNamespace(EventMask=SimpleNamespace(STRUCTURE_MASK=2), pixbuf_get_from_window=capture)
d.GdkX11 = SimpleNamespace(X11Window=SimpleNamespace(foreign_new_for_display=wrap))
d.attributes = lambda xid: attrs[xid]
assert d.capture_window(1, 100, 120) == (80, 60)
attrs[1] = SimpleNamespace(width=70, height=45)
assert d.capture_window(1, 100, 120) == (70, 45)
assert d.capture_window(1, 40, 20) == (40, 20)
assert d.capture_window(2, 50, 60) == (25, 35)
assert d.capture_window(2, 50, 60) == (25, 35)
assert wrapped == [1, 2], wrapped
assert target.masks == [10] and popup.masks == [10]

attrs[1] = SimpleNamespace(width=100, height=120)
updates = [True]
def configure(may_block):
    assert may_block is False
    if updates:
        updates.pop()
        target.width, target.height = 100, 120
        return True
    return False
d.context = SimpleNamespace(iteration=configure)
assert d.capture_window(1, 100, 120) == (100, 120)
assert target.masks == [10]
assert traps == ['push', 'pop'] * len(captures), traps
`);
});
