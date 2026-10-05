import crypto from "node:crypto";

// The signed "pass" a shopper's browser needs to open the live connection for ONE auction.
// It is handed out with the normal bidding-panel request (which Shopify has already signed), so only visitors who
// loaded the panel get one. A pass is the same for a whole hour (so the connection isn't re-opened needlessly) and
// is accepted for that hour and the next, so it stays valid for 1 to 2 hours.
const HOUR_MS = 60 * 60 * 1000;

function sign(auctionId, bucket, secret) {
  return crypto.createHmac("sha256", secret).update(`live:${auctionId}:${bucket}`).digest("hex").slice(0, 40);
}

export function liveToken(auctionId, secret, now = Date.now()) {
  if (!secret || !auctionId) return "";
  return sign(String(auctionId), Math.floor(now / HOUR_MS), secret);
}

export function validLiveToken(auctionId, token, now, secret) {
  if (!secret || !auctionId || typeof token !== "string" || token.length !== 40) return false;
  const bucket = Math.floor(now / HOUR_MS);
  const given = Buffer.from(token);
  for (const b of [bucket, bucket - 1]) {
    const expected = Buffer.from(sign(String(auctionId), b, secret));
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return true;
  }
  return false;
}
