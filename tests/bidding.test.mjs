import assert from "node:assert/strict";
import { resolveProxyBids, nextMinimumBid } from "../app/bidding.server.js";

const t0 = new Date("2026-10-01T10:00:00Z");
const at = (m) => new Date(t0.getTime() + m * 60000);
const bid = (id, bidderId, maxBid, m) => ({ id, bidderId, maxBid, createdAt: at(m) });
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log("ok -", name); };

check("first bid pays the starting bid only", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 0, bids: [bid("a", "A", 50, 0)] });
  assert.equal(r.leaderId, "A"); assert.equal(r.price, 10);
});

check("a lower second bid raises the price but the leader stays", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 10, bids: [bid("a", "A", 50, 0), bid("b", "B", 20, 1)] });
  assert.equal(r.leaderId, "A"); assert.equal(r.price, 21);
});

check("a higher second bid takes the lead at runner-up max plus increment", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 21, bids: [bid("a", "A", 50, 0), bid("b", "B", 60, 2)] });
  assert.equal(r.leaderId, "B"); assert.equal(r.price, 52);
});

check("exact tie: earlier bidder wins and pays full max", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 52, bids: [bid("b", "B", 60, 2), bid("c", "C", 60, 3)] });
  assert.equal(r.leaderId, "B"); assert.equal(r.price, 60);
});

check("leader raising own max does not change the price", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 21, bids: [bid("a", "A", 90, 0), bid("b", "B", 20, 1)] });
  assert.equal(r.leaderId, "A"); assert.equal(r.price, 21);
});

check("price never goes down", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 40, bids: [bid("a", "A", 90, 0), bid("b", "B", 20, 1)] });
  assert.equal(r.price, 40);
});

check("reserve met: price jumps to reserve", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 10, reservePrice: 80, bids: [bid("a", "A", 100, 0), bid("b", "B", 30, 1)] });
  assert.equal(r.price, 80); assert.equal(r.reserveMet, true);
});

check("reserve not met", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 10, reservePrice: 80, bids: [bid("a", "A", 70, 0), bid("b", "B", 30, 1)] });
  assert.equal(r.reserveMet, false);
});

check("no bids", () => {
  const r = resolveProxyBids({ startingBid: 10, currentBid: 0, bids: [] });
  assert.equal(r.leaderId, null);
});

check("your restored real auction stays at $325 with the same leader", () => {
  const r = resolveProxyBids({ startingBid: 1, currentBid: 325, bids: [
    bid("x1", "31238385893487", 335, 0), bid("x2", "31249278959727", 300, 100),
    bid("x3", "31249284628591", 307, 101), bid("x4", "31249357471855", 320, 102),
  ] });
  assert.equal(r.leaderId, "31238385893487"); assert.equal(r.price, 325);
});

check("tie after a raise: the bidder who reached the amount FIRST keeps the lead", () => {
  // A bid first (minute 0) with max 5; B bid at minute 1 with max 10 and leads.
  // A later RAISES to exactly 10 at minute 2 -> A's bid time becomes minute 2.
  const r = resolveProxyBids({ startingBid: 1, currentBid: 6, bids: [bid("a", "A", 10, 2), bid("b", "B", 10, 1)] });
  assert.equal(r.leaderId, "B");
  assert.equal(r.price, 10);
});

check("removing the leader: the next bidder leads at the starting bid", () => {
  const r = resolveProxyBids({ startingBid: 1, currentBid: 0, bids: [bid("b", "B", 10, 1)] });
  assert.equal(r.leaderId, "B");
  assert.equal(r.price, 1);
});

check("minimum next bid", () => {
  assert.equal(nextMinimumBid({ startingBid: 10, currentBid: 0, hasBids: false }), 10);
  assert.equal(nextMinimumBid({ startingBid: 10, currentBid: 21, hasBids: true }), 22);
  assert.equal(nextMinimumBid({ startingBid: 10, currentBid: 100, hasBids: true }), 105);
});

console.log(`\n${passed} checks passed`);
