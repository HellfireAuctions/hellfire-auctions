import assert from "node:assert/strict";
import { imageSize } from "../app/image-size.js";
import { squareCrop, outputSide, isSquare, photoProblem, SQUARE_MESSAGE, UNREADABLE_MESSAGE, PHOTO_SIDE } from "../app/photo-ratio.js";

// ---------- build tiny files of each kind with a known size ----------
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255];
const le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const txt = (s) => [...s].map((c) => c.charCodeAt(0));
const pad = (arr, n = 64) => Uint8Array.from([...arr, ...new Array(Math.max(0, n - arr.length)).fill(0)]);

const png = (w, h) => pad([0x89, ...txt("PNG"), 13, 10, 26, 10, ...be32(13), ...txt("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const gif = (w, h) => pad([...txt("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0]);
const jpeg = (w, h, { exifBytes = 0 } = {}) => {
  const app1 = exifBytes ? [0xff, 0xe1, ...be16(exifBytes + 2), ...new Array(exifBytes).fill(7)] : [];
  return pad([0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...txt("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, ...app1, 0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 200 + exifBytes);
};
const webpX = (w, h) => pad([...txt("RIFF"), 0, 0, 0, 0, ...txt("WEBP"), ...txt("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpL = (w, h) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return pad([...txt("RIFF"), 0, 0, 0, 0, ...txt("WEBP"), ...txt("VP8L"), 5, 0, 0, 0, 0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]);
};
const webp = (w, h) => pad([...txt("RIFF"), 0, 0, 0, 0, ...txt("WEBP"), ...txt("VP8 "), 10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);

// ---------- reading the real size from the file ----------
assert.deepEqual(imageSize(png(1200, 900)), { width: 1200, height: 900, type: "png" });
assert.deepEqual(imageSize(png(4000, 4000)), { width: 4000, height: 4000, type: "png" });
assert.deepEqual(imageSize(gif(640, 480)), { width: 640, height: 480, type: "gif" });
assert.deepEqual(imageSize(jpeg(3024, 4032)), { width: 3024, height: 4032, type: "jpeg" });
assert.deepEqual(imageSize(jpeg(1000, 1000)), { width: 1000, height: 1000, type: "jpeg" });
assert.deepEqual(imageSize(jpeg(2000, 1500, { exifBytes: 5000 })), { width: 2000, height: 1500, type: "jpeg" }, "a big metadata block before the size is skipped over");
assert.deepEqual(imageSize(webpX(800, 600)), { width: 800, height: 600, type: "webp" });
assert.deepEqual(imageSize(webpL(500, 700)), { width: 500, height: 700, type: "webp" });
assert.deepEqual(imageSize(webp(1024, 768)), { width: 1024, height: 768, type: "webp" });

// not photos, or damaged
for (const bad of [new Uint8Array(0), new Uint8Array(5), new Uint8Array(100), pad(txt("%PDF-1.7 not a photo")), pad(txt("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), jpeg(10, 10).slice(0, 20), png(10, 10).slice(0, 18), null, undefined]) {
  assert.equal(imageSize(bad), null);
}

// ---------- the square crop ----------
assert.deepEqual(squareCrop(4000, 3000), { sx: 500, sy: 0, side: 3000 }, "a wide photo is cropped from the sides, centred");
assert.deepEqual(squareCrop(3000, 4000), { sx: 0, sy: 500, side: 3000 }, "a tall photo is cropped top and bottom, centred");
assert.deepEqual(squareCrop(2000, 2000), { sx: 0, sy: 0, side: 2000 }, "a square photo is untouched");
assert.deepEqual(squareCrop(1001, 1000), { sx: 0, sy: 0, side: 1000 });
assert.deepEqual(squareCrop(100, 1), { sx: 49, sy: 0, side: 1 });
for (const [w, h] of [[4032, 3024], [3024, 4032], [1920, 1080], [1080, 1920], [5000, 1000], [999, 1000], [7, 3]]) {
  const { sx, sy, side } = squareCrop(w, h);
  assert.ok(sx >= 0 && sy >= 0 && sx + side <= w && sy + side <= h, `${w}x${h}: the crop stays inside the photo`);
  assert.equal(side, Math.min(w, h), `${w}x${h}: as much of the photo as possible is kept`);
}

// ---------- the size it is saved at ----------
assert.equal(outputSide(3000), PHOTO_SIDE, "big photos are scaled down");
assert.equal(outputSide(PHOTO_SIDE), PHOTO_SIDE);
assert.equal(outputSide(800), 800, "small photos are never enlarged");
assert.equal(outputSide(0), 1);
assert.equal(outputSide(2500, 1000), 1000);

// ---------- what counts as square ----------
assert.equal(isSquare(1000, 1000), true);
assert.equal(isSquare(1000, 1005), true, "within 1%");
assert.equal(isSquare(1005, 1000), true);
assert.equal(isSquare(1000, 1020), false);
assert.equal(isSquare(1600, 1200), false);
assert.equal(isSquare(0, 0), false);
assert.equal(isSquare(-5, 5), false);
assert.equal(isSquare(1000, 1020, 0.05), true, "the tolerance can be loosened");

// ---------- the server's check of uploaded files ----------
const file = (bytes) => ({ slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }) });
assert.equal(await photoProblem([]), null, "nothing to check");
assert.equal(await photoProblem([file(png(1600, 1600))]), null);
assert.equal(await photoProblem([file(jpeg(1000, 1000)), file(webp(512, 512)), file(gif(300, 300))]), null, "every kind of square photo passes");
assert.equal(await photoProblem([file(jpeg(4032, 3024))]), SQUARE_MESSAGE, "a normal camera photo is refused until it is squared");
assert.equal(await photoProblem([file(png(1000, 1000)), file(png(1000, 1300))]), SQUARE_MESSAGE, "one bad photo is enough");
assert.equal(await photoProblem([file(pad(txt("not a photo at all")))]), UNREADABLE_MESSAGE);
assert.equal(await photoProblem([file(new Uint8Array(0))]), UNREADABLE_MESSAGE);
assert.ok(SQUARE_MESSAGE.length > 40 && UNREADABLE_MESSAGE.length > 40 && SQUARE_MESSAGE !== UNREADABLE_MESSAGE);

console.log("Photo ratio: all checks passed");
