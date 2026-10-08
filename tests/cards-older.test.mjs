import assert from "node:assert/strict";
import { olderEndedEntry, OLDER_ENDED_DAYS, OLDER_ENDED_MAX } from "../app/cards-older.js";

const entry = olderEndedEntry("test-6", { startsAt: "2026-09-20T10:00:00.000Z", endsAt: "2026-09-27T10:00:00.000Z" });

// ---------- it says exactly one thing: this product's auction has ended ----------
assert.equal(entry.handle, "test-6");
assert.equal(entry.status, "ENDED");
assert.equal(entry.endsAt, "2026-09-27T10:00:00.000Z");
assert.equal(entry.startsAt, "2026-09-20T10:00:00.000Z");

// ---------- nothing about money, bidders or the viewer is revealed ----------
assert.equal(entry.hasBids, false);
assert.equal(entry.amount, 0);
assert.equal(entry.bidCount, 0);
assert.equal(entry.myStatus, null, "never says whether the viewer won");
assert.equal(entry.watchers, 0);
assert.equal(entry.bidders, 0);
assert.equal(entry.hot, false);
assert.equal(entry.isTest, false);
assert.equal(entry.reserveMet, null);

// ---------- the shape is the one the storefront script already reads (same fields as a normal entry) ----------
const normalKeys = ["handle", "hasBids", "amount", "bidCount", "startsAt", "endsAt", "status", "hot", "myStatus", "hasReserve", "watchers", "bidders", "isTest", "reserveMet"].sort();
assert.deepEqual(Object.keys(entry).sort(), normalKeys, "no field missing, none extra");

// ---------- the limits ----------
assert.equal(OLDER_ENDED_DAYS, 90);
assert.equal(OLDER_ENDED_MAX, 150, "matches the cap the storefront script applies");

console.log("Older ended auctions: all checks passed");
