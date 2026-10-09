import crypto from "node:crypto";

// The Live Studio opens in its own browser tab (cameras can't run inside Shopify's admin frame), so it can't use the
// admin's login. Instead the admin hands it a signed link good for one show, for four hours. The link can start and stop
// that show's video and run its items; it can do nothing else.

export const STUDIO_TTL_MS = 4 * 60 * 60 * 1000;

const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");
const sign = (payload, secret) => crypto.createHmac("sha256", `${secret}:studio`).update(payload).digest("base64url");

export function signStudioToken({ shop, saleId, secret, ttlMs = STUDIO_TTL_MS, now = Date.now() }) {
  const payload = b64(JSON.stringify({ s: shop, i: saleId, e: now + ttlMs }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyStudioToken(token, secret, now = Date.now()) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature || !secret) return { ok: false };
  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.s || !data?.i || !(data.e > now)) return { ok: false };
    return { ok: true, shop: data.s, saleId: data.i, expires: data.e };
  } catch {
    return { ok: false };
  }
}
