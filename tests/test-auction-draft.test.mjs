import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// ---------- DESIGN DECISION: an auction is always its own NEW listing ----------
// Hellfire Auctions never turns a merchant's existing product into an auction. That would risk selling the same physical
// item twice (once in the store, once to the auction winner). There is deliberately no "choose an existing product" picker.
const form = read("app/routes/app._index.jsx");
assert.ok(!form.includes("Choose an existing product"), "no existing-product picker (by design)");
assert.ok(!form.includes("resourcePicker"), "the form never opens a product picker");
assert.ok(!fs.existsSync("app/product-pick.js"), "and the helper for it is gone");
assert.ok(form.includes("(test only: no one is invoiced)") && !form.includes('(no sale)"'), "the test lengths are clearly labelled");

// ---------- a test auction on a live store makes its draft order, and never emails anyone ----------
const worker = read("app/auction-worker.server.js");
const fnStart = worker.indexOf("async function createAndSendWinnerInvoice");
const fn = worker.slice(fnStart, worker.indexOf("async function removeFromLiveAuctions"));
assert.ok(fn.includes("!opts.test) {\n    const joined"), "a test never joins a real combined invoice");
assert.ok(fn.includes('["Hellfire Auction", "Hellfire test auction"]'), "the test draft order is tagged so it is obvious");
assert.ok(fn.includes("not sent to the shopper"), "and noted as not sent");
const early = fn.indexOf("if (opts.test) return { draftOrderId, checkoutUrl };");
assert.ok(early > 0, "test mode returns early");
assert.ok(early < fn.indexOf("notifyWinner("), "BEFORE any email to the shopper is sent");
assert.ok(early < fn.indexOf("draftOrderInvoiceSend"), "and before Shopify's invoice email");
assert.ok(early > fn.indexOf("draftOrderCreate"), "but AFTER the draft order has been created and saved");
assert.ok(worker.includes("createAndSendWinnerInvoice(auction, testTopBidder, { test: true })"), "a test auction on a live store creates its draft order");
const settle = worker.slice(worker.indexOf("let winnerId = topBid && reserveMet && !testOnLiveStore"), worker.indexOf("await removeFromLiveAuctions(auction)"));
assert.ok(/testOnLiveStore && testTopBidder/.test(settle) && /catch \(error\)/.test(settle.slice(settle.indexOf("testOnLiveStore && testTopBidder"))), "and a failure to make the draft never breaks the ending");

// ---------- the merchant's email explains it ----------
const mail = read("app/notifications.server.js");
const testMail = mail.slice(mail.indexOf("export async function notifyMerchantTestEnded"), mail.indexOf("// Weekly backup"));
assert.ok(testMail.includes("draft_orders/") && testMail.includes("NOT emailed to the bidder"), "the email links to the draft order and says it was not sent");
assert.ok(testMail.includes("no winner, order or invoice was created"), "and keeps the old wording when there was no top bid");

console.log("Test-auction draft order, and the no-picker design decision: all checks passed");
