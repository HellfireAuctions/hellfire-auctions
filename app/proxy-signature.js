import crypto from "node:crypto";

// Shopify's app proxy signature check, in memory (no database, no logging). Pure, so it can be tested.
// message = every query parameter except "signature", sorted by name, written as name=value with no separators
// (a repeated name joins its values with commas); signature = HMAC-SHA256 of that, hex, using the app secret.
const TOLERANCE_SEC = 90;

export function validSignature(search, secret, nowSec = Date.now() / 1000) {
  if (!secret) return false;
  const params = new URLSearchParams(search);
  const signature = params.get("signature");
  if (!signature) return false;
  params.delete("signature");
  const grouped = {};
  for (const [key, value] of params.entries()) (grouped[key] ||= []).push(value);
  const message = Object.keys(grouped).sort().map((key) => `${key}=${grouped[key].join(",")}`).join("");
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(message).digest("hex"));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  const timestamp = Number(params.get("timestamp"));
  return Number.isFinite(timestamp) && Math.abs(nowSec - timestamp) <= TOLERANCE_SEC;
}

export const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
