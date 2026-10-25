import assert from "node:assert/strict";
import { test } from "node:test";
import { DisplayFitter, fitSize, modeline, parseXrandr, screenSize } from "./display.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const geometry = { screenWidth: 1920, screenHeight: 1080, workarea: { x: 80, y: 32, width: 1840, height: 1048 } };

function fakeDisplay(options = {}) {
  const modes = new Map([["1920x1080", { width: 1920, height: 1080 }], ["1600x900", { width: 1600, height: 900 }],
    ["paseo-1760x960", { width: 1760, height: 960 }]]);
  const attached = new Set(modes.keys());
  const commands = [];
  let current = "1920x1080";
  let active = 0;
  let maximumActive = 0;
  const output = options.output ?? "DUMMY0";
  const desktop = () => {
    const size = modes.get(current);
    return { screenWidth: size.width, screenHeight: size.height,
      workarea: { x: 80, y: 32, width: size.width - 80, height: size.height - 32 } };
  };
  const run = async (args) => {
    commands.push(args);
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      await options.beforeCommand?.(args);
      if (args[0] === "--query") {
        const size = modes.get(current);
        return `Screen 0: minimum 64 x 64, current ${size.width} x ${size.height}, maximum 32767 x 32767\n`
          + `${output} connected primary ${size.width}x${size.height}+0+0 0mm x 0mm\n`
          + [...attached].map((name) => `   ${name}   60.00${name === current ? "*+" : ""}`).join("\n")
          + "\nDUMMY1 disconnected\n"
          + [...modes.keys()].filter((name) => !attached.has(name)).map((name) => `  ${name} (0x123) 60MHz`).join("\n");
      }
      if (args[0] === "--listproviders") return options.providers ?? "Providers: number : 0\n";
      if (args[0] === "--newmode") {
        assert.ok(!modes.has(args[1]), "Creating an existing mode should be avoided");
        modes.set(args[1], { width: Number(args[3]), height: Number(args[7]) });
      } else if (args[0] === "--addmode") {
        assert.ok(modes.has(args[2]));
        attached.add(args[2]);
      } else if (args[0] === "--output") {
        assert.ok(attached.has(args[3]), `Mode must be attached: ${args[3]}`);
        current = args[3];
      } else if (args[0] === "--delmode") {
        assert.notEqual(args[2], current, "Never detach the current mode");
        attached.delete(args[2]);
      } else if (args[0] === "--rmmode") {
        assert.ok(!attached.has(args[1]), "Detach a mode before deleting it");
        modes.delete(args[1]);
      } else assert.fail(`Unexpected xrandr command: ${args.join(" ")}`);
      return "";
    } finally { active--; }
  };
  return { run, commands, modes, attached, readDesktop: async () => desktop(),
    get current() { return current; }, set current(value) { current = value; },
    get maximumActive() { return maximumActive; } };
}

function fitter(fake, options = {}) {
  return new DisplayFitter({ run: fake.run, readDesktop: fake.readDesktop, debounceMs: 20, idleMs: 10_000, ...options });
}

test("viewer sizing rounds down while honoring minimums, full HD and the cap", () => {
  assert.deepEqual(fitSize({ width: 1273, height: 836 }), { width: 1272, height: 832 });
  assert.deepEqual(fitSize({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.deepEqual(fitSize({ width: 390, height: 650 }), { width: 800, height: 1328 });
  assert.deepEqual(fitSize({ width: 161, height: 160 }), { width: 800, height: 792 });
  assert.deepEqual(fitSize({ width: 1440, height: 800 }), { width: 1440, height: 800 });
  assert.deepEqual(fitSize({ width: 5000, height: 3000 }), { width: 4096, height: 2456 });
  assert.deepEqual(fitSize({ width: 100, height: 8192 }), { width: 800, height: 4096 });
  assert.deepEqual(fitSize({ width: 8192, height: 100 }), { width: 4096, height: 600 });
  for (const width of [100, 390, 800, 1333, 8192]) {
    for (const height of [100, 650, 800, 2001, 8192]) {
      const result = fitSize({ width, height });
      assert.ok(result.width >= 800 && result.height >= 600);
      assert.ok(result.width <= 4096 && result.height <= 4096);
      assert.equal(result.width % 8, 0);
      assert.equal(result.height % 8, 0);
      if (width >= 800 && height >= 600) {
        assert.ok(result.width <= width && result.height <= height);
      }
    }
  }
});

test("screen margins and alignment do not change the targeted window dimensions", () => {
  const target = { width: 1280, height: 720 };
  assert.deepEqual(screenSize(target, geometry), { width: 1360, height: 752 });
  assert.deepEqual(screenSize(target, { ...geometry, workarea: { ...geometry.workarea, width: 1837 } }),
    { width: 1368, height: 752 });
  assert.deepEqual(target, { width: 1280, height: 720 });
  assert.throws(() => screenSize(target, { ...geometry, workarea: { ...geometry.workarea, width: 2000 } }), /valid work area/);
});

test("60 Hz modeline has the specified porches, clock and safe horizontal frequency", () => {
  const mode = modeline({ width: 1360, height: 752 });
  assert.deepEqual(mode.args, ["paseo-1360x752", "71.32", "1360", "1408", "1440", "1520",
    "752", "755", "760", "782", "-hsync", "+vsync"]);
  assert.ok(Math.abs(Number(mode.args[1]) * 1e6 / 1520 / 782 - 60) < 0.01);
  assert.ok(mode.horizontalKHz < 1000);
  assert.throws(() => modeline({ width: 4096, height: 20_000 }), /1000 kHz/);
});

test("RandR parsing identifies primary output, custom current mode and detached modes", () => {
  const parsed = parseXrandr("Screen 0: minimum 64 x 64, current 1360 x 752, maximum 32767 x 32767\n"
    + "DUMMY1 connected 100x100+0+0 0mm x 0mm\n   100x100 60.0*\n"
    + "DUMMY0 connected primary 1360x752+0+0 0mm x 0mm\n   paseo-1360x752 60.0*\n"
    + "DUMMY2 disconnected\n  paseo-1600x900 (0x123) 60MHz\n");
  assert.equal(parsed.outputs.find((item) => item.primary).mode, "paseo-1360x752");
  assert.ok(parsed.modes.has("paseo-1600x900"));
  assert.deepEqual(parsed.screen, { width: 1360, height: 752 });
});

test("debounce applies only the latest target; repeated target does no xrandr work", async () => {
  const fake = fakeDisplay();
  const display = fitter(fake);
  try {
    const first = display.fit({ width: 390, height: 650 });
    await sleep(5);
    const second = display.fit({ width: 1440, height: 800 });
    assert.equal(fake.commands.length, 0);
    assert.deepEqual(await first, { ok: true, width: 1440, height: 800, error: null });
    assert.deepEqual(await second, await first);
    assert.equal(fake.current, "paseo-1520x832");
    assert.equal(fake.commands.filter((args) => args[0] === "--newmode").length, 1);
    const count = fake.commands.length;
    assert.deepEqual(await display.fit({ width: 1440, height: 800 }), await first);
    assert.equal(fake.commands.length, count);
  } finally { assert.equal((await display.stop()).ok, true); }
  assert.equal(fake.current, "1920x1080");
  assert.ok(fake.modes.has("paseo-1760x960"), "A mode made by someone else must remain");
  assert.equal(fake.modes.size, 3);
});

test("xrandr work is serialized and superseded queued requests use the latest size", async () => {
  let release;
  let first = true;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fake = fakeDisplay({ beforeCommand: async (args) => {
    if (args[0] === "--newmode" && first) { first = false; await blocked; }
  } });
  const display = fitter(fake);
  try {
    const a = display.fit({ width: 1280, height: 720 });
    await sleep(40);
    const b = display.fit({ width: 1400, height: 800 });
    await sleep(40);
    const c = display.fit({ width: 1600, height: 900 });
    release();
    assert.equal((await a).width, 1280);
    assert.equal((await b).width, 1600);
    assert.equal((await c).width, 1600);
    assert.equal((await c).height, 896);
    assert.equal(fake.maximumActive, 1);
    assert.equal(fake.current, "paseo-1680x928");
    assert.ok(!fake.modes.has("paseo-1360x752"), "Earlier owned mode should be removed");
    assert.ok(!fake.modes.has("paseo-1480x832"), "Superseded queued mode should never be made");
    assert.ok(fake.modes.has("paseo-1760x960"));
  } finally { release(); await display.stop(); }
});

test("frame reads delay idle restoration; a fit after restoration remembers the original again", async () => {
  const fake = fakeDisplay();
  const display = fitter(fake, { idleMs: 140 });
  try {
    await display.fit({ width: 1280, height: 720 });
    await sleep(90);
    display.frameRead();
    await sleep(90);
    assert.equal(fake.current, "paseo-1360x752");
    await sleep(90);
    assert.equal(fake.current, "1920x1080");
    assert.ok(!fake.modes.has("paseo-1360x752"));
    fake.current = "1600x900";
    await display.fit({ width: 1440, height: 800 });
  } finally { await display.stop(); }
  assert.equal(fake.current, "1600x900");
});

test("idle timeout counts from a frame read that arrived before the first resize", async () => {
  const fake = fakeDisplay();
  const display = fitter(fake, { idleMs: 160 });
  try {
    display.frameRead();
    await sleep(100);
    await display.fit({ width: 1280, height: 720 });
    await sleep(70);
    assert.equal(fake.current, "1920x1080");
  } finally { await display.stop(); }
});

test("cleanup cancels pending fits and waits for an active fit before restoring", async () => {
  const untouched = fakeDisplay();
  const pendingDisplay = fitter(untouched);
  const pending = pendingDisplay.fit({ width: 1280, height: 720 });
  await pendingDisplay.stop();
  assert.equal((await pending).ok, false);
  assert.equal(untouched.commands.length, 0);
  assert.equal((await pendingDisplay.fit({ width: 1280, height: 720 })).ok, false);

  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fake = fakeDisplay({ beforeCommand: async (args) => { if (args[0] === "--newmode") await blocked; } });
  const display = fitter(fake);
  const fitting = display.fit({ width: 1280, height: 720 });
  await sleep(40);
  const stopped = display.stop();
  release();
  assert.equal((await fitting).ok, true);
  assert.equal((await stopped).ok, true);
  assert.equal(fake.current, "1920x1080");
  assert.equal(fake.modes.size, 3);
});

test("physical displays are rejected; a provider explicitly reporting dummy is supported", async () => {
  const physical = fakeDisplay({ output: "HDMI-1" });
  const rejected = fitter(physical);
  try {
    assert.deepEqual(await rejected.fit({ width: 1280, height: 720 }), {
      ok: false, width: 0, height: 0, error: "Only a virtual display can be resized; this one is HDMI-1.",
    });
    assert.ok(physical.commands.every((args) => ["--query", "--listproviders"].includes(args[0])));
  } finally { await rejected.stop(); }
  const dummy = fakeDisplay({ output: "default", providers: "Provider 0: id: 0x123 cap: 0x0 name:dummy\n" });
  const supported = fitter(dummy);
  try { assert.equal((await supported.fit({ width: 1280, height: 720 })).ok, true); }
  finally { await supported.stop(); }
});

test("missing xrandr and command stderr become RPC errors without throwing", async () => {
  const missing = new DisplayFitter({ run: async () => { throw Object.assign(new Error("spawn xrandr ENOENT"), { code: "ENOENT" }); },
    readDesktop: async () => geometry, debounceMs: 1 });
  try { assert.match((await missing.fit({ width: 1280, height: 720 })).error, /xrandr is not installed/); }
  finally { await missing.stop(); }
  const fake = fakeDisplay({ beforeCommand: async (args) => {
    if (args[0] === "--addmode") throw Object.assign(new Error("Command failed"), { stderr: "BadMatch: mode cannot be added" });
  } });
  const display = fitter(fake);
  try {
    assert.deepEqual(await display.fit({ width: 1280, height: 720 }), {
      ok: false, width: 0, height: 0, error: "xrandr: BadMatch: mode cannot be added",
    });
  } finally { assert.equal((await display.stop()).ok, true); }
  assert.equal(fake.modes.size, 3, "An unattached owned mode from a failed fit must also be removed");
});

test("a pre-existing requested paseo mode can be reused without claiming ownership", async () => {
  const fake = fakeDisplay();
  const display = fitter(fake);
  try {
    assert.equal((await display.fit({ width: 1680, height: 928 })).ok, true);
    assert.equal(fake.current, "paseo-1760x960");
    assert.equal(fake.commands.filter((args) => args[0] === "--newmode").length, 0);
  } finally { await display.stop(); }
  assert.ok(fake.modes.has("paseo-1760x960"));
  assert.equal(fake.modes.size, 3);
});

test("a dummy provider alongside a physical provider does not authorize resizing a physical output", async () => {
  const fake = fakeDisplay({ output: "HDMI-1", providers: "Provider 0: name:NVIDIA-0\nProvider 1: name:dummy\n" });
  const display = fitter(fake);
  try {
    assert.match((await display.fit({ width: 1280, height: 720 })).error, /Only a virtual display/);
    assert.ok(fake.commands.every((args) => ["--query", "--listproviders"].includes(args[0])));
  } finally { await display.stop(); }
});

test("an already-created modeline is tolerated only after RandR confirms that mode exists", async () => {
  const fake = fakeDisplay();
  const run = async (args) => {
    if (args[0] === "--newmode") {
      fake.modes.set(args[1], { width: Number(args[3]), height: Number(args[7]) });
      throw Object.assign(new Error("Create mode failed"), { stderr: "BadName: mode already exists" });
    }
    return fake.run(args);
  };
  const display = fitter(fake, { run });
  try {
    assert.equal((await display.fit({ width: 1280, height: 720 })).ok, true);
    assert.equal(fake.current, "paseo-1360x752");
  } finally { await display.stop(); }
  assert.ok(fake.modes.has("paseo-1360x752"), "A mode created by another caller should remain");
});
