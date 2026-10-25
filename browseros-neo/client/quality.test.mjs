import test from "node:test";
import assert from "node:assert/strict";
import { frameSettings, rememberedQuality, rememberQuality } from "./quality.ts";

const options = {
  qualityMode: false, compact: false, native: false, zoom: false,
  box: { width: 390, height: 844 }, pixelRatio: 3, shown: { width: 800, height: 1440 },
};

test("normal mode keeps device-pixel capture sizing and platform JPEG quality", () => {
  assert.deepEqual(frameSettings(options), { maxWidth: 1170, maxHeight: 2532, quality: 70, lossless: false });
  assert.equal(frameSettings({ ...options, compact: true }).quality, 55);
  assert.equal(frameSettings({ ...options, native: true }).quality, 55);
  assert.deepEqual(frameSettings({ ...options, native: true, zoom: true }), {
    maxWidth: 800, maxHeight: 1440, quality: 55, lossless: false,
  });
  assert.deepEqual(frameSettings({ ...options, zoom: true, shown: null }), frameSettings(options));
});

test("Quality Mode captures the whole displayed window losslessly with JPEG quality 95 fallback", () => {
  assert.deepEqual(frameSettings({ ...options, qualityMode: true }), {
    maxWidth: 800, maxHeight: 1440, quality: 95, lossless: true,
  });
  assert.deepEqual(frameSettings({ ...options, qualityMode: true, compact: true, native: true, zoom: true, shown: null }), {
    maxWidth: 1920, maxHeight: 1080, quality: 95, lossless: true,
  });
  assert.deepEqual(frameSettings({ ...options, qualityMode: true, shown: { width: 20000, height: 12000 } }), {
    maxWidth: 8192, maxHeight: 8192, quality: 95, lossless: true,
  });
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
