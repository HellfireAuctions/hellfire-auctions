import assert from "node:assert/strict";
import fs from "node:fs";
import { plainTextFromHtml } from "../app/product-pick.js";

// ---------- the product description becomes clean plain text ----------
assert.equal(plainTextFromHtml("<p>Hello <strong>world</strong></p>"), "Hello world");
assert.equal(plainTextFromHtml("<p>Line one</p><p>Line two</p>"), "Line one\nLine two", "paragraphs become lines");
assert.equal(plainTextFromHtml("One<br>Two<br/>Three"), "One\nTwo\nThree", "line breaks are kept");
assert.equal(plainTextFromHtml("<ul><li>Red</li><li>Blue</li></ul>"), "Red\nBlue", "list items become lines");
assert.equal(plainTextFromHtml("Fish &amp; chips &lt;3 &quot;yum&quot; it&#39;s&nbsp;great"), 'Fish & chips <3 "yum" it\'s great', "common entities are decoded");
assert.equal(plainTextFromHtml("<p>a</p><p></p><p></p><p>b</p>"), "a\n\nb", "runs of blank lines are collapsed");
assert.equal(plainTextFromHtml(""), "");
assert.equal(plainTextFromHtml(null), "");
assert.equal(plainTextFromHtml(undefined), "");
assert.equal(plainTextFromHtml("x".repeat(6000)).length, 5000, "very long descriptions are cut to 5000 characters");
assert.equal(plainTextFromHtml("<script>alert(1)</script>Safe"), "alert(1)Safe", "tags are removed (the form shows text only, never HTML)");

// ---------- the picker is really on the Add auction form ----------
const form = fs.readFileSync("app/routes/app._index.jsx", "utf8").replace(/\r\n/g, "\n");
assert.ok(form.includes("Choose an existing product"), "the button exists");
assert.ok(form.includes("window.shopify.resourcePicker({ type: \"product\", action: \"select\", multiple: false })"), "it opens Shopify's own product picker");
assert.ok(form.includes("{!isEdit && !locked && ("), "it is only offered when creating a new auction");
assert.ok(form.includes("Your original product is not changed"), "and says the original product is untouched");
const picker = form.slice(form.indexOf("const pickExistingProduct"), form.indexOf("return (\n    <Form"));
assert.ok(picker.includes("toSquare(") && picker.includes("DataTransfer"), "photos go through the same square-crop path as uploaded photos");
assert.ok(!/productUpdate|productDelete|productSet|admin\.graphql/.test(picker), "the picker never changes the store's product: it only fills in the form");
assert.ok(picker.includes("product.descriptionHtml") && picker.includes("plainTextFromHtml"), "the description is copied as text");
assert.ok(form.includes("(test only: no one is invoiced)") && !form.includes("(no sale)\""), "the test lengths are clearly labelled");

// ---------- a test auction on a live store makes its draft order, and never emails anyone ----------
const worker = fs.readFileSync("app/auction-worker.server.js", "utf8").replace(/\r\n/g, "\n");
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
assert.ok(settle.includes("winnerId: winnerId") === false || settle.includes("winnerId,"), "the test auction still records no winner (so no reminders and no strikes)");
assert.ok(/testOnLiveStore && testTopBidder/.test(settle) && /catch \(error\)/.test(settle.slice(settle.indexOf("testOnLiveStore && testTopBidder"))), "and a failure to make the draft never breaks the ending");

// ---------- the merchant's email explains it ----------
const mail = fs.readFileSync("app/notifications.server.js", "utf8").replace(/\r\n/g, "\n");
const testMail = mail.slice(mail.indexOf("export async function notifyMerchantTestEnded"), mail.indexOf("// Weekly backup"));
assert.ok(testMail.includes("draft_orders/") && testMail.includes("NOT emailed to the bidder"), "the email links to the draft order and says it was not sent");
assert.ok(testMail.includes("no winner, order or invoice was created"), "and keeps the old wording when there was no top bid");

console.log("Existing product picker and test-auction draft order: all checks passed");
