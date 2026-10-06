import assert from "node:assert/strict";
import { computeAnalytics, insights, isSold, localParts, weekStart } from "../app/analytics.js";

const now = new Date("2026-10-20T12:00:00Z");
const NY = "America/New_York";
let n = 0;
const auc = (over = {}) => ({ id: "a" + ++n, status: "ENDED", isTest: false, startingBid: 10, currentBid: 10, bidCount: 0, reservePrice: null, buyNowPrice: null, winnerId: null, endsAt: "2026-10-10T15:00:00Z", ...over });
const run = (auctions, extra = {}) => computeAnalytics({ auctions, now, ...extra });

// ---------- nothing to analyse: no NaN, no crashes ----------
const empty = run([]);
assert.equal(empty.totals.ended, 0);
assert.equal(empty.totals.sellThrough, null);
assert.equal(empty.totals.avgPrice, null);
assert.equal(empty.totals.paidRate, null);
assert.equal(empty.totals.upliftPct, null);
assert.equal(empty.totals.revenue, 0);
assert.equal(empty.byHour.length, 24);
assert.equal(empty.byDay.length, 7);
assert.deepEqual(empty.byWeek, []);
assert.equal(empty.bestHour, null);
assert.equal(empty.bestDay, null);
assert.deepEqual(empty.topBuyers, []);
assert.ok(!JSON.stringify(empty).includes("NaN"));
assert.deepEqual(insights(empty), []);

// ---------- what counts as sold, and what is left out ----------
assert.equal(isSold(auc({ bidCount: 3, currentBid: 30 })), true);
assert.equal(isSold(auc({ bidCount: 2, currentBid: 100, reservePrice: 100 })), true, "reached the reserve exactly");
assert.equal(isSold(auc({ bidCount: 4, currentBid: 40, reservePrice: 100 })), false, "bids, but below the reserve");
assert.equal(isSold(auc({ bidCount: 0 })), false);
assert.equal(isSold(auc({ bidCount: "3", currentBid: "30" })), true, "numbers stored as text work");

const base = [
  auc({ bidCount: 3, currentBid: 30, startingBid: 10 }),
  auc({ bidCount: 2, currentBid: 100, startingBid: 50, reservePrice: 100 }),
  auc({ bidCount: 4, currentBid: 40, reservePrice: 100 }),
  auc({ bidCount: 0 }),
];
const left = [
  auc({ isTest: true, bidCount: 5, currentBid: 500 }),
  auc({ status: "CANCELLED", bidCount: 5, currentBid: 500 }),
  auc({ endsAt: "2026-10-25T00:00:00Z", bidCount: 5, currentBid: 500 }),
  auc({ endsAt: "2026-08-01T00:00:00Z", bidCount: 5, currentBid: 500 }),
];
let r = run([...base, ...left]);
assert.equal(r.totals.ended, 4, "tests, cancelled, still-running and too-old auctions are left out");
assert.equal(r.totals.sold, 2);
assert.equal(r.totals.unsold, 2);
assert.equal(r.totals.unsoldNoBids, 1);
assert.equal(r.totals.unsoldReserve, 1);
assert.equal(r.totals.sellThrough, 0.5);
assert.equal(r.totals.revenue, 130);
assert.equal(r.totals.avgPrice, 65);
assert.equal(r.totals.avgBids, 2.5);
assert.equal(r.totals.upliftPct, 150, "(30/10 - 1 = 200%) and (100/50 - 1 = 100%) average to 150%");
assert.equal(run([...base, ...left], { days: 365 }).totals.ended, 5, "a longer period brings the older auction in");

// ---------- the store's own time zone ----------
const late = auc({ bidCount: 1, currentBid: 20, endsAt: "2026-10-07T01:30:00Z" });
let tz = run([late], { timeZone: NY });
assert.equal(tz.byHour[21].ended, 1, "01:30 UTC is 9:30 PM the evening before in New York");
assert.equal(tz.byDay[2].ended, 1, "...which is a Tuesday");
tz = run([late], { timeZone: "UTC" });
assert.equal(tz.byHour[1].ended, 1);
assert.equal(tz.byDay[3].ended, 1, "...but a Wednesday in UTC");
assert.deepEqual(localParts("2026-10-07T01:30:00Z", NY), { y: 2026, m: 10, d: 6, hour: 21, dow: 2 });
assert.equal(localParts("2026-10-07T00:00:00Z", "UTC").hour, 0, "midnight is hour 0, never 24");

// weeks start on Monday in the store's time zone
assert.equal(weekStart("2026-10-12T02:00:00Z", NY), "2026-10-05", "Sunday evening in New York belongs to the week before");
assert.equal(weekStart("2026-10-12T02:00:00Z", "UTC"), "2026-10-12");
assert.equal(weekStart("2026-10-11T12:00:00Z", "UTC"), "2026-10-05", "Sunday belongs to the week that began on the Monday before");
const weekly = run([auc({ bidCount: 1, currentBid: 10, endsAt: "2026-10-14T12:00:00Z" }), auc({ bidCount: 1, currentBid: 15, endsAt: "2026-10-06T12:00:00Z" }), auc({ bidCount: 0, endsAt: "2026-10-07T12:00:00Z" })]);
assert.deepEqual(weekly.byWeek.map((w) => [w.weekStart, w.ended, w.sold, w.revenue]), [["2026-10-05", 2, 1, 15], ["2026-10-12", 1, 1, 10]], "weeks are in order with their own totals");

// ---------- the best time to end an auction needs enough auctions behind it ----------
const ends = (iso, sold) => auc(sold ? { bidCount: 2, currentBid: 40, endsAt: iso } : { bidCount: 0, endsAt: iso });
const timesData = [
  ends("2026-10-07T01:10:00Z", true), ends("2026-10-08T01:10:00Z", true), ends("2026-10-09T01:10:00Z", false), // 9 PM NY: 2 of 3
  ends("2026-10-12T14:10:00Z", true), ends("2026-10-13T14:10:00Z", true), // 10 AM NY: 2 of 2, too few to trust
  ends("2026-10-14T19:10:00Z", false), ends("2026-10-15T19:10:00Z", false), ends("2026-10-16T19:10:00Z", false), // 3 PM NY: 0 of 3
];
r = run(timesData, { timeZone: NY });
assert.equal(r.bestHour.hour, 21);
assert.equal(r.bestHour.ended, 3);
assert.ok(Math.abs(r.bestHour.sellThrough - 2 / 3) < 1e-9);
const tuesdays = ["2026-10-06T19:00:00Z", "2026-09-29T19:00:00Z", "2026-09-22T19:00:00Z"].map((d) => ends(d, true));
r = run(tuesdays, { timeZone: NY });
assert.equal(r.bestDay.name, "Tue");
assert.equal(r.bestDay.sellThrough, 1);
assert.equal(run(tuesdays.slice(0, 2), { timeZone: NY }).bestDay, null, "two auctions are not enough to call it a pattern");

// ---------- payment ----------
const t12 = (iso, hours) => new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
const p1 = auc({ bidCount: 3, currentBid: 50, winnerId: "A", endsAt: "2026-10-10T12:00:00Z" });
const p2 = auc({ bidCount: 3, currentBid: 30, winnerId: "A", endsAt: "2026-10-10T13:00:00Z" });
const p3 = auc({ bidCount: 3, currentBid: 100, winnerId: "B", endsAt: "2026-10-11T12:00:00Z" });
const p4 = auc({ bidCount: 3, currentBid: 20, winnerId: "C", endsAt: "2026-10-19T12:00:00Z" });
const paid = new Map([[p1.id, t12(p1.endsAt, 12)], [p3.id, t12(p3.endsAt, 24)]]);
r = run([p1, p2, p3, p4], { paid });
assert.ok(Math.abs(r.totals.paidRate - 2 / 3) < 1e-9, "only items past the 4-day payment window count toward the paid rate");
assert.equal(r.totals.awaitingPayment, 2);
assert.equal(r.totals.unpaidValue, 50);
assert.equal(r.totals.avgHoursToPay, 18);
assert.deepEqual(r.topBuyers.map((b) => [b.winnerId, b.wins, b.spent, b.paid]), [["B", 1, 100, 1], ["A", 2, 80, 1], ["C", 1, 20, 0]], "biggest spenders first");
const many = Array.from({ length: 25 }, (_, i) => auc({ bidCount: 1, currentBid: 10 + i, winnerId: "w" + i }));
assert.equal(run(many).topBuyers.length, 10, "the top ten");
assert.equal(run(many).topBuyers[0].winnerId, "w24");
assert.equal(run([auc({ bidCount: 1, currentBid: 10, winnerId: null })]).topBuyers.length, 0, "no winner recorded yet");

// ---------- Buy It Now ----------
r = run([auc({ bidCount: 1, currentBid: 80, buyNowPrice: 80 }), auc({ bidCount: 3, currentBid: 90, buyNowPrice: 80 }), auc({ bidCount: 2, currentBid: 80, buyNowPrice: 80 }), auc({ bidCount: 1, currentBid: 15 })]);
assert.deepEqual(r.buyNow, { count: 1, revenue: 80 });

// ---------- plain-language observations ----------
const sample = { totals: { ended: 10, sold: 3, sellThrough: 0.3, unsoldNoBids: 5, unsoldReserve: 2, paidRate: 0.5, upliftPct: 150 }, bestHour: { hour: 21, sellThrough: 0.5 }, bestDay: { name: "Tue", sellThrough: 0.6 } };
const tips = insights(sample);
assert.equal(tips.length, 5);
assert.ok(tips[0].includes("5 of your 10 auctions got no bids"));
assert.ok(tips.some((t) => t.includes("21:00")) && tips.some((t) => t.includes("Tue")) && tips.some((t) => t.includes("50%")) && tips.some((t) => t.includes("150%")));
assert.ok(insights({ ...sample, totals: { ...sample.totals, unsoldReserve: 4 } }).some((t) => t.includes("reserve")));
assert.deepEqual(insights({ ...sample, totals: { ...sample.totals, ended: 4 } }), [], "too few auctions to say anything");
assert.deepEqual(insights({ totals: { ended: 20, sold: 19, sellThrough: 0.95, unsoldNoBids: 1, unsoldReserve: 0, paidRate: 0.99, upliftPct: 20 }, bestHour: null, bestDay: null }), [], "a healthy store gets no nagging");

// ---------- speed ----------
const big = Array.from({ length: 5000 }, (_, i) => auc({ bidCount: i % 3, currentBid: 10 + (i % 50), winnerId: "w" + (i % 200), endsAt: new Date(now.getTime() - (i % 28) * 86_400_000 - (i % 24) * 3_600_000).toISOString() }));
const t0 = Date.now();
r = run(big, { timeZone: NY, days: 30 });
assert.ok(Date.now() - t0 < 1500, "5,000 auctions are analysed in well under 1.5 seconds");
assert.ok(r.totals.ended > 4000 && !JSON.stringify(r).includes("NaN"));

console.log("Seller analytics: all checks passed");
