import assert from "node:assert/strict";
import fs from "node:fs";
import { sellNowDecision } from "../app/sell-now.js";

const now = new Date("2026-10-21T12:00:00Z");
const auction = (over = {}) => ({ status: "LIVE", endsAt: "2026-10-22T12:00:00Z", isTest: false, bidCount: 3, currentBid: 40, reservePrice: null, ...over });

// ---------- when "End now and sell" is allowed ----------
assert.deepEqual(sellNowDecision(auction(), now), { ok: true }, "a running real auction with bids");
assert.equal(sellNowDecision(auction({ reservePrice: 40 }), now).ok, true, "reserve exactly met");
assert.equal(sellNowDecision(auction({ reservePrice: 30 }), now).ok, true, "reserve exceeded");
assert.equal(sellNowDecision(auction({ bidCount: "2" }), now).ok, true, "a bid count that arrives as text still counts");

// ---------- and when it is refused, with a plain reason ----------
assert.match(sellNowDecision(auction({ bidCount: 0 }), now).message, /no bids/, "nobody to sell to");
assert.match(sellNowDecision(auction({ reservePrice: 100 }), now).message, /reserve/, "reserve not met");
assert.match(sellNowDecision(auction({ isTest: true }), now).message, /Test auctions/, "test auctions can't be sold");
assert.match(sellNowDecision(auction({ endsAt: "2026-10-21T11:59:00Z" }), now).message, /already ended/, "past its end time");
assert.match(sellNowDecision(auction({ endsAt: "2026-10-21T12:00:00Z" }), now).message, /already ended/, "exactly at its end time");
for (const status of ["CANCELLED", "ENDED", "SETTLING"]) assert.match(sellNowDecision(auction({ status }), now).message, /already ended/, status);
for (const status of ["DRAFT", "UPCOMING"]) assert.match(sellNowDecision(auction({ status }), now).message, /Only a running auction/, status);
assert.match(sellNowDecision(null, now).message, /could not be found/);
assert.match(sellNowDecision(undefined, now).message, /could not be found/);
assert.equal(sellNowDecision(auction({ bidCount: null }), now).ok, false, "unknown bid count: no sale");
assert.equal(sellNowDecision(auction({ currentBid: 40, reservePrice: "40.01" }), now).ok, false, "a reserve given as text is compared as a number");

// ---------- it is really wired in ----------
const route = fs.readFileSync("app/routes/app._index.jsx", "utf8");
const worker = fs.readFileSync("app/auction-worker.server.js", "utf8");
assert.ok(route.includes('if (intent === "sell-now") {'), "the admin has the action");
assert.ok(route.includes("sellNowDecision(target, new Date())"), "the action checks the rules on the server (never trusts the button)");
assert.ok(route.includes("settleAuctionNow(session.shop, target.id)"), "and settles through the same code as a normal ending");
assert.ok(route.includes('value="sell-now"') && route.includes("End now and sell"), "and the button is on the auction card");
assert.ok(route.includes("sellNowDecision(auction).ok ?") && route.includes("End now and sell isn&rsquo;t available yet"), "shown when it works, and otherwise says why");
assert.ok(worker.includes("export async function settleAuctionNow(shop, auctionId)"), "the worker can settle one auction immediately");
const settle = worker.slice(worker.indexOf("export async function settleAuctionNow"), worker.indexOf("export function wakeWorker"));
assert.ok(settle.includes("await settleAuction(") && settle.includes("status: \"LIVE\""), "it only touches a running auction, using the normal settle routine");

// the dev-store check records what Shopify says about stores it does not treat as development stores
const plans = fs.readFileSync("app/plans.server.js", "utf8");
assert.ok(plans.includes("displayName") && plans.includes("[plan] not treated as a development store"), "the plan check leaves a trace for stores it does not recognise");

console.log("End now and sell: all checks passed");
