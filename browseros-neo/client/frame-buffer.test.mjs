import test from "node:test";
import assert from "node:assert/strict";
import { bufferedFrame, frameImageUri, retainFrameImage, sameFramePixels } from "./frame-buffer.ts";

const old = {
  status: "ready", reason: null, windows: [], windowId: "0x1", windowWidth: 1840, windowHeight: 1048,
  hash: "a", changed: true, image: "jpeg-a", mimeType: "image/jpeg", imageWidth: 920, imageHeight: 524,
};

test("identical JPEG pixels retain their buffer while resize metadata changes", () => {
  const resized = { ...old, changed: false, image: null, windowWidth: 920, windowHeight: 524 };
  const next = bufferedFrame(resized, [old, null]);
  assert.equal(next.image, "jpeg-a");
  assert.equal(next.windowWidth, 920);
  assert.equal(next.windowHeight, 524);
  assert.deepEqual(retainFrameImage(old, resized), next);
  assert.equal(sameFramePixels(old, resized), true);
});

test("PNG and JPEG sources use the returned MIME and never reuse bytes across formats", () => {
  assert.equal(frameImageUri("image/png", "png-data"), "data:image/png;base64,png-data");
  assert.equal(frameImageUri("image/jpeg", "jpeg-fallback"), "data:image/jpeg;base64,jpeg-fallback");
  const png = { ...old, mimeType: "image/png", image: null, changed: false };
  assert.equal(sameFramePixels(old, png), false);
  assert.equal(bufferedFrame(png, [old]), null);
  assert.equal(retainFrameImage(old, png).image, null);
});

test("an unchanged displayed hash cannot inherit bytes from a different pending hash", () => {
  const pending = { ...old, hash: "b", image: "jpeg-b" };
  const unchanged = { ...old, changed: false, image: null };
  const frame = retainFrameImage(pending, unchanged);
  assert.equal(frame.image, null);
  assert.equal(bufferedFrame(frame, [old, pending]).image, "jpeg-a");
  assert.equal(bufferedFrame(frame, [null, pending]), null);
  assert.equal(bufferedFrame({ ...unchanged, windowId: "0x2" }, [old]), null);
  assert.equal(sameFramePixels(pending, unchanged), false);
  assert.equal(sameFramePixels(null, unchanged), false);
  assert.equal(sameFramePixels(old, { ...unchanged, windowId: "0x2" }), false);
});
