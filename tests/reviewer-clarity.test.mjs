import assert from "node:assert/strict";
import fs from "node:fs";
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const route = read("app/routes/app._index.jsx");
const worker = read("app/auction-worker.server.js");

// settling works for a running auction AND one ended early, never for one that already has a winner
const fn = worker.slice(worker.indexOf("export async function settleAuctionNow"), worker.indexOf("export function wakeWorker"));
assert.ok(fn.includes('status: { in: ["LIVE", "CANCELLED"] }'), "an auction ended early can be settled");
assert.ok(fn.includes('running.status === "CANCELLED" && running.winnerId'), "but not one that is already sold");
assert.ok(fn.includes('status: "LIVE"') && fn.indexOf('status: "LIVE"') < fn.indexOf("await settleAuction("), "it is put back to running first so the normal routine sells it");

// the sold message tells the truth about combined invoices
assert.ok(route.includes("this win was added to it (") && route.includes("items on one draft order"), "a combined win is explained");
assert.ok(route.includes("a new Shopify draft order was created"), "a separate invoice is called new");
assert.ok(route.includes('click \\"Open the draft order in Shopify\\" on the auction card') || route.includes('"Open the draft order in Shopify" on the auction card'), "and points to the card link");

// every sold auction shows where its draft order is
assert.ok(route.includes('shopify://admin/draft_orders/') && route.includes("Open the draft order in Shopify"), "a sold card links to its draft order");
assert.ok(route.includes("draftShared: auction.winnerDraftOrderId"), "and says when wins share one invoice");
assert.ok(route.includes('"Sell to the high bidder" : "End now and sell"'), "the button reads Sell to the high bidder on an auction ended early");
assert.ok(route.includes("Changed your mind?"), "and ending early tells the merchant they can still sell it");
console.log("Reviewer clarity: all checks passed");
