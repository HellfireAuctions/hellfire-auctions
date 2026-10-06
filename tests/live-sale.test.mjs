import assert from "node:assert/strict";
import { parseLotSeconds, embedFor, isRunning, startSale, startNextLot, skipLot, extendLot, endLot, endSale, roomView, LOT_MIN, LOT_MAX, LOT_DEFAULT } from "../app/live-sale.js";

const now = new Date("2026-10-06T20:00:00Z");
const at = (s) => new Date(now.getTime() + s * 1000);
const sale = (over = {}) => ({ title: "Friday frag night", status: "LIVE", lotIds: ["a", "b", "c"], currentIndex: -1, lotSeconds: 120, ...over });
const lot = (id, over = {}) => ({ id, productId: "gid://shopify/Product/" + id, title: "Lot " + id, imageUrl: null, startingBid: 10, currentBid: 10, bidCount: 0, reservePrice: null, startsAt: at(3600), endsAt: at(7200), ...over });

// ---------- lot length ----------
assert.equal(parseLotSeconds("90"), 90);
assert.equal(parseLotSeconds(5), LOT_MIN, "never shorter than the minimum");
assert.equal(parseLotSeconds(99999), LOT_MAX, "never longer than the maximum");
assert.equal(parseLotSeconds("abc"), LOT_DEFAULT);
assert.equal(parseLotSeconds(""), 30, "an empty box is read as 0 and raised to the minimum");
assert.equal(parseLotSeconds(119.6), 120);

// ---------- video links ----------
assert.deepEqual(embedFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { kind: "youtube", src: "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&rel=0" });
assert.equal(embedFor("https://youtu.be/dQw4w9WgXcQ?t=5").kind, "youtube");
assert.equal(embedFor("https://m.youtube.com/live/dQw4w9WgXcQ").src.includes("/embed/dQw4w9WgXcQ"), true);
assert.equal(embedFor("https://www.youtube.com/embed/dQw4w9WgXcQ").kind, "youtube");
assert.equal(embedFor("https://vimeo.com/123456789").src, "https://player.vimeo.com/video/123456789?autoplay=1&muted=1");
assert.equal(embedFor("https://www.facebook.com/hellfirefrags/videos/123456789/").kind, "facebook");
assert.ok(embedFor("https://fb.watch/abc123/").src.startsWith("https://www.facebook.com/plugins/video.php?href="));
assert.equal(embedFor("https://www.twitch.tv/HellfireFrags").src, "https://player.twitch.tv/?channel=hellfirefrags&parent={parent}&muted=true");
for (const bad of ["", null, undefined, "not a link", "http://youtu.be/dQw4w9WgXcQ", "https://evil.example/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=<script>", "https://www.youtube.com/watch", "javascript:alert(1)", "https://vimeo.com/abc", "https://www.twitch.tv/", "https://www.twitch.tv/a b", "https://www.youtube.com/watch?v=" + "x".repeat(40)]) {
  assert.equal(embedFor(bad), null, String(bad));
}

// ---------- starting the sale ----------
assert.deepEqual(startSale(sale({ status: "DRAFT" })), { ok: true, saleUpdate: { status: "LIVE", currentIndex: -1 } });
assert.equal(startSale(sale({ status: "LIVE" })).ok, false);
assert.equal(startSale(sale({ status: "ENDED" })).ok, false);
assert.equal(startSale(sale({ status: "DRAFT", lotIds: [] })).ok, false, "an empty sale can't start");

// ---------- starting lots ----------
let r = startNextLot({ sale: sale(), current: null, next: lot("a"), now });
assert.equal(r.ok, true);
assert.equal(r.lotNumber, 1);
assert.deepEqual(r.saleUpdate, { currentIndex: 0 });
assert.equal(r.auctionUpdate.startsAt.getTime(), now.getTime(), "the lot goes live right now");
assert.equal(r.auctionUpdate.endsAt.getTime(), now.getTime() + 120_000, "for exactly the lot length");
assert.equal(startNextLot({ sale: sale({ lotSeconds: 45 }), current: null, next: lot("a"), now }).auctionUpdate.endsAt.getTime(), now.getTime() + 45_000);

assert.equal(startNextLot({ sale: sale({ status: "DRAFT" }), current: null, next: lot("a"), now }).ok, false, "the sale must be live");
assert.equal(startNextLot({ sale: sale({ status: "ENDED" }), current: null, next: lot("a"), now }).ok, false);

// a running lot blocks the next one
const running = lot("a", { startsAt: at(-30), endsAt: at(90) });
assert.equal(isRunning(running, now), true);
r = startNextLot({ sale: sale({ currentIndex: 0 }), current: running, next: lot("b"), now });
assert.equal(r.ok, false);
assert.match(r.error, /still running/);
// once it has ended, the next one can start
const finished = lot("a", { startsAt: at(-150), endsAt: at(-30), bidCount: 3, currentBid: 55 });
assert.equal(isRunning(finished, now), false);
r = startNextLot({ sale: sale({ currentIndex: 0 }), current: finished, next: lot("b"), now });
assert.equal(r.ok, true);
assert.deepEqual(r.saleUpdate, { currentIndex: 1 });
assert.equal(r.lotNumber, 2);

// a lot that already has bids or already started can't be run (and can be skipped)
r = startNextLot({ sale: sale(), current: null, next: lot("a", { bidCount: 2 }), now });
assert.equal(r.ok, false);
assert.equal(r.canSkip, true);
r = startNextLot({ sale: sale(), current: null, next: lot("a", { startsAt: at(-5), endsAt: at(500) }), now });
assert.equal(r.ok, false, "an auction that has already started is not started a second time");
assert.equal(startNextLot({ sale: sale(), current: null, next: null, now }).canSkip, true, "a deleted lot can be skipped");

// after the last lot the sale finishes
r = startNextLot({ sale: sale({ currentIndex: 2 }), current: finished, next: null, now });
assert.deepEqual(r, { ok: true, finished: true, saleUpdate: { status: "ENDED" } });

// ---------- skipping ----------
assert.deepEqual(skipLot({ sale: sale(), current: null, now }), { ok: true, saleUpdate: { currentIndex: 0 } });
assert.equal(skipLot({ sale: sale({ currentIndex: 0 }), current: running, now }).ok, false, "can't skip while a lot runs");
assert.equal(skipLot({ sale: sale({ currentIndex: 2 }), current: finished, now }).ok, false, "nothing left to skip");
assert.equal(skipLot({ sale: sale({ status: "DRAFT" }), current: null, now }).ok, false);
// after a skip, the skipped (never started) lot does not block the next one
const skipped = lot("a");
assert.equal(startNextLot({ sale: sale({ currentIndex: 0 }), current: skipped, next: lot("b"), now }).ok, true);

// ---------- extending ----------
assert.equal(extendLot({ current: running, seconds: 30, now }).auctionUpdate.endsAt.getTime(), running.endsAt.getTime() + 30_000);
assert.equal(extendLot({ current: running, seconds: "abc", now }).auctionUpdate.endsAt.getTime(), running.endsAt.getTime() + 30_000, "defaults to 30 seconds");
assert.equal(extendLot({ current: running, seconds: 1, now }).auctionUpdate.endsAt.getTime(), running.endsAt.getTime() + 5_000, "at least 5 seconds");
assert.equal(extendLot({ current: running, seconds: 9999, now }).ok, false, "never beyond 10 minutes in one go");
assert.equal(extendLot({ current: finished, seconds: 30, now }).ok, false, "an ended lot can't be extended");
assert.equal(extendLot({ current: null, seconds: 30, now }).ok, false);
assert.equal(extendLot({ current: lot("z"), seconds: 30, now }).ok, false, "a lot that hasn't started can't be extended");

// ---------- ending a lot ----------
assert.equal(endLot({ current: running, now }).auctionUpdate.endsAt.getTime(), now.getTime());
assert.equal(endLot({ current: finished, now }).ok, false);
assert.equal(endLot({ current: null, now }).ok, false);

// ---------- ending the sale ----------
assert.deepEqual(endSale({ sale: sale({ currentIndex: 0 }), current: finished, now }), { ok: true, saleUpdate: { status: "ENDED" } });
assert.deepEqual(endSale({ sale: sale({ status: "DRAFT" }), current: null, now }), { ok: true, saleUpdate: { status: "ENDED" } });
assert.equal(endSale({ sale: sale({ currentIndex: 0 }), current: running, now }).ok, false, "end the lot first");
assert.equal(endSale({ sale: sale({ status: "ENDED" }), current: null, now }).ok, false);

// ---------- what the live room shows ----------
const all = [lot("a", { startsAt: at(-150), endsAt: at(-30), bidCount: 4, currentBid: 80 }), lot("b", { startsAt: at(-30), endsAt: at(90), bidCount: 1, currentBid: 12 }), lot("c"), lot("d")];
let v = roomView({ sale: sale({ lotIds: ["a", "b", "c", "d"], currentIndex: 1 }), auctions: all, now });
assert.equal(v.phase, "live");
assert.equal(v.lotNumber, 2);
assert.equal(v.lotCount, 4);
assert.equal(v.current.id, "b");
assert.equal(v.current.running, true);
assert.deepEqual(v.upcoming.map((l) => l.id), ["c", "d"]);
assert.deepEqual(v.done.map((l) => [l.id, l.sold, l.finalPrice]), [["a", true, 80]], "the finished lot shows what it sold for");
assert.ok(!JSON.stringify(v).match(/bidderId|customer|email/i), "nothing personal is ever shown");

// between lots: the last result shows, nothing is "now selling"
v = roomView({ sale: sale({ lotIds: ["a", "b", "c", "d"], currentIndex: 0 }), auctions: [all[0], ...all.slice(2)], now });
assert.equal(v.phase, "between");
assert.equal(v.current, null);
assert.deepEqual(v.done.map((l) => l.id), ["a"]);
assert.deepEqual(v.upcoming.map((l) => l.id), ["c", "d"].slice(0, 2).filter(() => true));

// before the first lot, and when the sale has ended
v = roomView({ sale: sale({ lotIds: ["a", "b"], currentIndex: -1 }), auctions: [lot("a"), lot("b")], now });
assert.equal(v.phase, "before");
assert.deepEqual(v.upcoming.map((l) => l.id), ["a", "b"]);
assert.equal(roomView({ sale: sale({ status: "DRAFT", lotIds: ["a"] }), auctions: [lot("a")], now }).phase, "before");
assert.equal(roomView({ sale: sale({ status: "ENDED", lotIds: ["a", "b"], currentIndex: 1 }), auctions: all.slice(0, 2), now }).phase, "ended");

// unsold lots and reserves
const unsold = lot("u", { startsAt: at(-150), endsAt: at(-30), bidCount: 0 });
const reserveNotMet = lot("r", { startsAt: at(-150), endsAt: at(-30), bidCount: 3, currentBid: 40, reservePrice: 100 });
const reserveMet = lot("m", { startsAt: at(-150), endsAt: at(-30), bidCount: 3, currentBid: 100, reservePrice: 100 });
v = roomView({ sale: sale({ status: "ENDED", lotIds: ["u", "r", "m"], currentIndex: 2 }), auctions: [unsold, reserveNotMet, reserveMet], now });
assert.deepEqual(v.done.map((l) => [l.id, l.sold, l.finalPrice]), [["u", false, null], ["r", false, null], ["m", true, 100]], "no sale without bids or below the reserve");

// a deleted lot is skipped quietly, and the room never lists more than it should
v = roomView({ sale: sale({ lotIds: ["a", "gone", "c"], currentIndex: -1 }), auctions: [lot("a"), lot("c")], now });
assert.deepEqual(v.upcoming.map((l) => l.id), ["a", "c"]);
const many = Array.from({ length: 30 }, (_, i) => lot("l" + i));
v = roomView({ sale: sale({ lotIds: many.map((l) => l.id), currentIndex: -1 }), auctions: many, now });
assert.equal(v.upcoming.length, 8, "at most 8 upcoming lots are listed");

// the version changes whenever something the room should react to changes
const base = roomView({ sale: sale({ currentIndex: 0 }), auctions: [lot("a", { startsAt: at(-5), endsAt: at(100) })], now }).version;
assert.notEqual(roomView({ sale: sale({ currentIndex: 1 }), auctions: [lot("b", { startsAt: at(-5), endsAt: at(100) })], now }).version, base);
assert.notEqual(roomView({ sale: sale({ currentIndex: 0 }), auctions: [lot("a", { startsAt: at(-5), endsAt: at(130) })], now }).version, base, "extending a lot");
assert.notEqual(roomView({ sale: sale({ currentIndex: 0, status: "ENDED" }), auctions: [lot("a", { startsAt: at(-5), endsAt: at(100) })], now }).version, base, "ending the sale");

console.log("Live sale rules: all checks passed");
