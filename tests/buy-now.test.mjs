import assert from "node:assert/strict";
import { parseBuyNowPrice, buyNowOffer, BUY_NOW_MESSAGES } from "../app/buy-now.js";

// ---------- what the merchant types ----------
const ctx = { startingBid: 10, reservePrice: null };
assert.deepEqual(parseBuyNowPrice("", ctx), { ok: true, value: null }, "empty means no Buy It Now");
assert.deepEqual(parseBuyNowPrice(null, ctx), { ok: true, value: null });
assert.deepEqual(parseBuyNowPrice(undefined, ctx), { ok: true, value: null });
assert.deepEqual(parseBuyNowPrice("   ", ctx), { ok: true, value: null });
assert.deepEqual(parseBuyNowPrice("50", ctx), { ok: true, value: 50 });
assert.deepEqual(parseBuyNowPrice("49.999", ctx), { ok: true, value: 50 }, "rounded to cents");
assert.deepEqual(parseBuyNowPrice("10.01", ctx), { ok: true, value: 10.01 }, "one cent above the starting bid is fine");
assert.equal(parseBuyNowPrice("10", ctx).ok, false, "equal to the starting bid is not above it");
assert.equal(parseBuyNowPrice("9", ctx).ok, false, "below the starting bid");
assert.equal(parseBuyNowPrice("0", ctx).ok, false);
assert.equal(parseBuyNowPrice("-5", ctx).ok, false);
assert.equal(parseBuyNowPrice("abc", ctx).ok, false);
assert.equal(parseBuyNowPrice("NaN", ctx).ok, false);
assert.equal(parseBuyNowPrice("Infinity", ctx).ok, false);
assert.deepEqual(parseBuyNowPrice("99999", ctx), { ok: true, value: 99999 }, "the largest allowed price");
assert.equal(parseBuyNowPrice("100000", ctx).ok, false, "above the largest allowed price");
assert.match(parseBuyNowPrice("100000", ctx).error, /99,999/);

// next to a reserve: at least the reserve (equal is fine)
const withReserve = { startingBid: 10, reservePrice: 40 };
assert.equal(parseBuyNowPrice("39.99", withReserve).ok, false, "below the reserve");
assert.deepEqual(parseBuyNowPrice("40", withReserve), { ok: true, value: 40 }, "equal to the reserve");
assert.deepEqual(parseBuyNowPrice("75", withReserve), { ok: true, value: 75 });
assert.match(parseBuyNowPrice("39", withReserve).error, /reserve/);
assert.match(parseBuyNowPrice("9", ctx).error, /starting bid/);

// every error is a plain sentence a merchant can act on
for (const bad of ["abc", "0", "9", "100000"]) {
  const r = parseBuyNowPrice(bad, ctx);
  assert.ok(typeof r.error === "string" && r.error.length > 20 && !r.error.includes("undefined"), bad);
}

// ---------- can a shopper buy it right now? ----------
const now = new Date("2026-10-06T12:00:00Z");
const base = { buyNowPrice: 50, reservePrice: null, startingBid: 10, bidCount: 0, startsAt: "2026-10-06T10:00:00Z", endsAt: "2026-10-07T10:00:00Z", now };
assert.deepEqual(buyNowOffer(base), { available: true, price: 50 });
assert.deepEqual(buyNowOffer({ ...base, startsAt: new Date("2026-10-06T10:00:00Z"), endsAt: new Date("2026-10-07T10:00:00Z") }), { available: true, price: 50 }, "real Date objects work too");
assert.deepEqual(buyNowOffer({ ...base, buyNowPrice: "50.00" }), { available: true, price: 50 }, "a price stored as text works");
assert.deepEqual(buyNowOffer({ ...base, buyNowPrice: 49.999 }), { available: true, price: 50 });

// no price set
for (const none of [null, undefined, 0, -1, "abc", NaN]) {
  assert.deepEqual(buyNowOffer({ ...base, buyNowPrice: none }), { available: false, reason: BUY_NOW_MESSAGES.none }, String(none));
}

// the first bid ends Buy It Now, however many bids follow
assert.deepEqual(buyNowOffer({ ...base, bidCount: 1 }), { available: false, reason: BUY_NOW_MESSAGES.gone });
assert.deepEqual(buyNowOffer({ ...base, bidCount: 25 }), { available: false, reason: BUY_NOW_MESSAGES.gone });
assert.deepEqual(buyNowOffer({ ...base, bidCount: "2" }), { available: false, reason: BUY_NOW_MESSAGES.gone });

// timing: not before it starts, not once it has ended (the end instant itself is already over)
assert.deepEqual(buyNowOffer({ ...base, now: new Date("2026-10-06T09:59:59Z") }), { available: false, reason: BUY_NOW_MESSAGES.notStarted });
assert.deepEqual(buyNowOffer({ ...base, now: new Date("2026-10-06T10:00:00Z") }), { available: true, price: 50 }, "available the moment it starts");
assert.deepEqual(buyNowOffer({ ...base, now: new Date("2026-10-07T09:59:59Z") }), { available: true, price: 50 }, "available until the last second");
assert.deepEqual(buyNowOffer({ ...base, now: new Date("2026-10-07T10:00:00Z") }), { available: false, reason: BUY_NOW_MESSAGES.ended });
assert.deepEqual(buyNowOffer({ ...base, now: new Date("2026-10-08T00:00:00Z") }), { available: false, reason: BUY_NOW_MESSAGES.ended });

// protections if data was ever inconsistent: never sell below the starting bid or the reserve
assert.deepEqual(buyNowOffer({ ...base, buyNowPrice: 10 }), { available: false, reason: BUY_NOW_MESSAGES.gone });
assert.deepEqual(buyNowOffer({ ...base, buyNowPrice: 5 }), { available: false, reason: BUY_NOW_MESSAGES.gone });
assert.deepEqual(buyNowOffer({ ...base, reservePrice: 60 }), { available: false, reason: BUY_NOW_MESSAGES.gone }, "price below the reserve");
assert.deepEqual(buyNowOffer({ ...base, reservePrice: 50 }), { available: true, price: 50 }, "price equal to the reserve");
assert.deepEqual(buyNowOffer({ ...base, reservePrice: 20 }), { available: true, price: 50 });

// the messages shoppers can see are the ones the storefront already translates
assert.equal(BUY_NOW_MESSAGES.notStarted, "This auction has not started yet.");
assert.equal(BUY_NOW_MESSAGES.ended, "This auction has ended.");
assert.equal(new Set(Object.values(BUY_NOW_MESSAGES)).size, 4);

console.log("Buy It Now rules: all checks passed");
