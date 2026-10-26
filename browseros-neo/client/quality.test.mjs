import test from "node:test";
import assert from "node:assert/strict";
import { frameSettings, rememberedQuality, rememberQuality } from "./quality.ts";

const options = {
  qualityMode: false, compact: false, native: false, zoom: false,
  box: { width: 390, height: 844 }, pixelRatio: 3, shown: { width: 800, height: 1440 },
};

test("normal mode keeps device-pixel capture sizing and platform JPEG quality", () => {
  assert.deepEqual(frameSettings(options), { maxWidth: 1170, maxHeight: 2532, quality: 80, lossless: false });
  assert.equal(frameSettings({ ...options, compact: true }).quality, 72);
  assert.equal(frameSettings({ ...options, native: true }).quality, 72);
  assert.deepEqual(frameSettings({ ...options, native: true, zoom: true }), {
    maxWidth: 800, maxHeight: 1440, quality: 72, lossless: false,
  });
  assert.deepEqual(frameSettings({ ...options, zoom: true, shown: null }), frameSettings(options));
});

test("Quality Mode changes only bitrate and still refinement, preserving frame dimensions in every layout", () => {
  assert.deepEqual(frameSettings({ ...options, qualityMode: true }), {
    maxWidth: 1170, maxHeight: 2532, quality: 92, lossless: true,
  });
  for (const settings of [options,
    { ...options, compact: true, native: true },
    { ...options, zoom: true },
    { ...options, zoom: true, shown: null },
    { ...options, shown: { width: 20000, height: 12000 } },
    { ...options, box: { width: 10000, height: 12000 } },
  ]) {
    const normal = frameSettings(settings);
    assert.deepEqual(frameSettings({ ...settings, qualityMode: true }), { ...normal, quality: 92, lossless: true });
  }
});

test("Quality Mode is remembered per host across screen and module instances for the session", async () => {
  const host = "quality-test-host";
  const other = "quality-test-other-host";
  try {
    assert.equal(rememberedQuality(host), false);
    rememberQuality(host, true);
    const reopened = await import("./quality.ts?reopened");
    assert.equal(reopened.rememberedQuality(host), true);
    assert.equal(reopened.rememberedQuality(other), false);
    rememberQuality(other, true);
    rememberQuality(host, false);
    assert.equal(reopened.rememberedQuality(host), false);
    assert.equal(reopened.rememberedQuality(other), true);
  } finally {
    rememberQuality(host, false);
    rememberQuality(other, false);
  }
});
