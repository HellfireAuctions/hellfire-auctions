import assert from "node:assert/strict";
import { olderEndedEntry, orderForCards, OLDER_ENDED_DAYS, OLDER_ENDED_MAX } from "../app/cards-older.js";

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

// ---------- the badge list's ordering (newest-first from the database in, oldest-first out, ended before active) ----------
const row = (id, product) => ({ id, productId: product });
const activeNewestFirst = [row("a3", "P3"), row("a2", "P2"), row("a1", "P1")];
const endedNewestFirst = [row("e2", "P5"), row("e1", "P4")];
assert.deepEqual(orderForCards(activeNewestFirst, endedNewestFirst).map((r) => r.id), ["e1", "e2", "a1", "a2", "a3"], "ended first (oldest to newest), then active (oldest to newest)");

// a relisted product: its old ended auction comes before its new live one, so the live one is the last entry and wins
const relisted = orderForCards([row("live-new", "PX")], [row("ended-old", "PX")]);
const winner = new Map();
for (const r of relisted) winner.set(r.productId, r.id); // the storefront script's rule: a later entry replaces an earlier one
assert.equal(winner.get("PX"), "live-new", "the relisted product is treated by its newest auction");

// it never loses or invents entries
const many = Array.from({ length: 250 }, (_, i) => row("x" + i, "P" + i));
assert.equal(orderForCards(many, many).length, 500);
assert.deepEqual(orderForCards([], []), []);
assert.deepEqual(orderForCards(undefined, null), [], "missing lists never crash");
assert.deepEqual(orderForCards(activeNewestFirst, undefined).map((r) => r.id), ["a1", "a2", "a3"]);
const before = [row("n1", "P1"), row("n2", "P2")];
orderForCards(before, before);
assert.deepEqual(before.map((r) => r.id), ["n1", "n2"], "the lists it was given are left untouched");

console.log("Older ended auctions: all checks passed");
