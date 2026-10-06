// Reads a photo's width and height straight from the start of the file (PNG, JPEG, GIF, WebP), without decoding it.
// Returns { width, height, type } or null when the bytes aren't a photo we recognise.
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b, i, n) => String.fromCharCode(...b.slice(i, i + n));

export function imageSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 12) return null;

  // PNG
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b.length >= 24 && ascii(b, 12, 4) === "IHDR") {
    return { width: u32be(b, 16), height: u32be(b, 20), type: "png" };
  }
  // GIF
  if (ascii(b, 0, 3) === "GIF") return { width: u16le(b, 6), height: u16le(b, 8), type: "gif" };

  // JPEG: walk the segments until the one that holds the size
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = u16be(b, i + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { width: u16be(b, i + 7), height: u16be(b, i + 5), type: "jpeg" };
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }

  // WebP
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP" && b.length >= 30) {
    const kind = ascii(b, 12, 4);
    if (kind === "VP8X") return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27), type: "webp" };
    if (kind === "VP8L") {
      return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)), type: "webp" };
    }
    if (kind === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, type: "webp" };
  }
  return null;
}
