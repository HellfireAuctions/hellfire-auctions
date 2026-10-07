import dns from "node:dns/promises";
import net from "node:net";
import { imageSize } from "./image-size.js";
import { isSquare } from "./photo-ratio.js";

// Checks that a photo LINK (from a CSV import) points to a square photo, by downloading only the first 256 KB and
// reading its shape. The server is fetching an address a person typed, so it refuses anything that isn't an ordinary
// public https address: no private or internal networks, no odd ports, no logins in the address, and every redirect is
// checked again. Anything it can't verify is refused with a plain message: the rule is "square photos only".

export const LINK_NOT_SQUARE = "The photo at this link isn't square (1:1). Crop it to a square first, or upload the photo in the form, which crops it for you.";
export const LINK_UNREADABLE = "We couldn't read the photo at this link. Use a direct https:// link to a JPG, PNG, WebP or GIF image.";
const MAX_BYTES = 262144;
const MAX_REDIRECTS = 3;

export function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, includes cloud metadata addresses
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (family === 6) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPublicIp(mapped[1]);
    if (v === "::" || v === "::1") return false;
    if (/^f[cd]/.test(v)) return false; // unique local
    if (/^fe[89ab]/.test(v)) return false; // link-local
    if (v.startsWith("ff")) return false; // multicast
    return true;
  }
  return false;
}

// Is this an ordinary public https address? Returns the parsed address or null.
export function publicHttpsUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (u.port && u.port !== "443") return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || net.isIP(host.replace(/^\[|\]$/g, "")) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return null;
  return u;
}

async function readHead(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - at);
    out.set(c.subarray(0, take), at);
    at += take;
    if (at >= out.length) break;
  }
  return out;
}

export async function urlPhotoProblem(raw, { lookup = (h) => dns.lookup(h, { all: true }), fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  try {
    let url = publicHttpsUrl(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!url) return LINK_UNREADABLE;
      const addresses = await lookup(url.hostname);
      if (!addresses.length || addresses.some((a) => !isPublicIp(a.address))) return LINK_UNREADABLE;
      const response = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Range: `bytes=0-${MAX_BYTES - 1}`, Accept: "image/*", "User-Agent": "HellfireAuctions/1.0 (photo shape check)" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return LINK_UNREADABLE;
        url = publicHttpsUrl(new URL(location, url).toString());
        continue;
      }
      if (!(response.ok || response.status === 206) || !response.body) return LINK_UNREADABLE;
      const type = response.headers.get("content-type") || "";
      if (!/^image\//i.test(type) && !/octet-stream/i.test(type)) return LINK_UNREADABLE;
      const size = imageSize(await readHead(response));
      if (!size) return LINK_UNREADABLE;
      return isSquare(size.width, size.height) ? null : LINK_NOT_SQUARE;
    }
    return LINK_UNREADABLE; // too many redirects
  } catch {
    return LINK_UNREADABLE; // a timeout or a network error: it can't be verified
  }
}
