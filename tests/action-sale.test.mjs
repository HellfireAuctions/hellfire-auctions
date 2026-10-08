import assert from "node:assert/strict";
import { parseDrop, claimDecision, openDecision, roomView, invoiceLines, remaining, MAX_QUANTITY } from "../app/action-sale.js";

const V = "gid://shopify/ProductVariant/123";
const P = "gid://shopify/Product/456";
const good = { title: "Rainbow Zoa frag", variantId: V, productId: P, price: "25", quantity: "5", perPerson: "2", imageUrl: "https://cdn.shopify.com/a.jpg" };

// ---------- the host's form ----------
let r = parseDrop(good);
assert.equal(r.ok, true);
assert.deepEqual(r.drop, { title: "Rainbow Zoa frag", variantId: V, productId: P, imageUrl: "https://cdn.shopify.com/a.jpg", price: 25, quantity: 5, perPerson: 2 });
assert.equal(parseDrop({ ...good, price: "24.999" }).drop.price, 25, "rounded to cents");
assert.equal(parseDrop({ ...good, perPerson: "" }).drop.perPerson, 1, "one each unless the host says otherwise");
assert.equal(parseDrop({ ...good, perPerson: "99", quantity: "3" }).drop.perPerson, 3, "never more per person than the quantity");
assert.equal(parseDrop({ ...good, perPerson: "0" }).drop.perPerson, 1);
assert.equal(parseDrop({ ...good, quantity: "1", perPerson: "5" }).drop.perPerson, 1);
assert.equal(parseDrop({ ...good, imageUrl: "http://insecure.example/x.jpg" }).drop.imageUrl, null, "only https images");
assert.equal(parseDrop({ ...good, imageUrl: "javascript:alert(1)" }).drop.imageUrl, null);
assert.equal(parseDrop(new URLSearchParams(good)).ok, true, "works with a real form submission too");
assert.equal(parseDrop({ ...good, title: "A\u0000B\nC" }).drop.title, "A B C", "control characters are removed");
assert.equal(parseDrop({ ...good, title: "x".repeat(500) }).drop.title.length, 120);
for (const [why, bad] of [
  ["no title", { ...good, title: "  " }], ["no product", { ...good, variantId: "", productId: "" }], ["a made-up product id", { ...good, variantId: "123" }],
  ["a script as a product id", { ...good, productId: "gid://shopify/Product/1<script>" }], ["zero price", { ...good, price: "0" }], ["negative price", { ...good, price: "-5" }],
  ["text price", { ...good, price: "abc" }], ["a huge price", { ...good, price: "100000" }], ["zero quantity", { ...good, quantity: "0" }], ["text quantity", { ...good, quantity: "many" }],
  ["too many", { ...good, quantity: String(MAX_QUANTITY + 1) }], ["no quantity", { ...good, quantity: "" }],
]) assert.equal(parseDrop(bad).ok, false, why);
assert.equal(parseDrop(null).ok, false);
assert.equal(parseDrop(undefined).ok, false);

// ---------- claiming ----------
const drop = (over = {}) => ({ id: "d1", status: "OPEN", quantity: 5, claimed: 0, perPerson: 1, ...over });
assert.deepEqual(claimDecision({ saleStatus: "LIVE", drop: drop(), already: 0 }), { ok: true, quantity: 1, soldOutAfter: false });
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ claimed: 4 }), already: 0 }).soldOutAfter, true, "the last one");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ claimed: 5 }), already: 0 }).code, "SOLD_OUT");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ claimed: 9 }), already: 0 }).code, "SOLD_OUT", "never negative");
assert.equal(claimDecision({ saleStatus: "DRAFT", drop: drop() }).code, "NOT_LIVE");
assert.equal(claimDecision({ saleStatus: "ENDED", drop: drop() }).code, "NOT_LIVE");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ status: "QUEUED" }) }).code, "NOT_OPEN", "can't claim what isn't open yet");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ status: "CLOSED" }) }).code, "NOT_OPEN");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: null }).code, "NOT_OPEN");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ perPerson: 2 }), already: 2 }).code, "LIMIT", "the per-person limit");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ perPerson: 2 }), already: 1 }).ok, true, "one more is allowed");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ perPerson: 3, claimed: 4 }), already: 0, want: 3 }).quantity, 1, "never more than what is left");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ perPerson: 3 }), already: 1, want: 5 }).quantity, 2, "never more than the limit allows");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ perPerson: 3 }), want: 0 }).quantity, 1, "always at least one");
assert.equal(claimDecision({ saleStatus: "LIVE", drop: drop({ perPerson: 3 }), want: "abc" }).quantity, 1);

// the rush: 40 people tap, one at a time through the lock; exactly 5 win, never 6
let d = drop({ quantity: 5, claimed: 0, perPerson: 1 });
const held = new Map();
let winners = 0, soldOut = 0;
for (let person = 0; person < 40; person += 1) {
  const decision = claimDecision({ saleStatus: "LIVE", drop: d, already: held.get(person) || 0 });
  if (decision.ok) {
    held.set(person, (held.get(person) || 0) + decision.quantity);
    d = { ...d, claimed: d.claimed + decision.quantity, status: d.claimed + decision.quantity >= d.quantity ? "CLOSED" : "OPEN" };
    winners += 1;
  } else {
    assert.ok(["SOLD_OUT", "NOT_OPEN"].includes(decision.code));
    soldOut += 1;
  }
}
assert.equal(winners, 5, "exactly the quantity");
assert.equal(soldOut, 35);
assert.equal(d.claimed, 5);
assert.equal(d.status, "CLOSED", "closes itself when sold out");
// one eager person with a limit of 3 and quantity of 10
d = drop({ quantity: 10, perPerson: 3 });
let mine = 0;
for (let tap = 0; tap < 10; tap += 1) {
  const dec = claimDecision({ saleStatus: "LIVE", drop: d, already: mine });
  if (dec.ok) { mine += dec.quantity; d = { ...d, claimed: d.claimed + dec.quantity }; }
}
assert.equal(mine, 3, "ten taps, three items");

// ---------- opening ----------
assert.equal(openDecision({ saleStatus: "LIVE", drop: drop({ status: "QUEUED" }) }).ok, true);
assert.equal(openDecision({ saleStatus: "LIVE", drop: drop({ status: "CLOSED", claimed: 2 }) }).ok, true, "an item with some left can be reopened");
assert.equal(openDecision({ saleStatus: "LIVE", drop: drop({ status: "CLOSED", claimed: 5 }) }).ok, false, "a sold-out item cannot");
assert.equal(openDecision({ saleStatus: "LIVE", drop: drop({ status: "OPEN" }) }).ok, false, "already open");
assert.equal(openDecision({ saleStatus: "DRAFT", drop: drop({ status: "QUEUED" }) }).ok, false, "start the show first");
assert.equal(openDecision({ saleStatus: "ENDED", drop: drop({ status: "QUEUED" }) }).ok, false);
assert.equal(openDecision({ saleStatus: "LIVE", drop: null }).ok, false);

// ---------- what shoppers see ----------
const item = (id, position, status, claimed, over = {}) => ({ id, position, status, claimed, quantity: 5, perPerson: 2, price: 25, title: "Item " + id, imageUrl: null, variantId: "gid://shopify/ProductVariant/" + id, ...over });
const drops = [item("a", 1, "CLOSED", 5), item("b", 2, "OPEN", 2), item("c", 3, "QUEUED", 0), item("d", 4, "QUEUED", 0)];
let v = roomView({ sale: { title: "Friday", status: "LIVE" }, drops, myClaims: [{ dropId: "a", quantity: 1 }, { dropId: "b", quantity: 2 }] });
assert.equal(v.phase, "open");
assert.equal(v.open.id, "b");
assert.equal(v.open.remaining, 3);
assert.equal(v.open.mine, 2, "how many this shopper holds of the open item");
assert.deepEqual(v.upcoming.map((u) => u.title), ["Item c", "Item d"]);
assert.deepEqual(v.results.map((x) => [x.title, x.soldOut]), [["Item a", true]]);
assert.deepEqual(v.mine, [{ title: "Item a", price: 25, quantity: 1 }, { title: "Item b", price: 25, quantity: 2 }]);
assert.equal(v.mineTotal, 75);
assert.ok(!JSON.stringify(v).match(/customer|email|claims"/i), "nothing about anyone else, and no ids of shoppers");
assert.equal(roomView({ sale: { title: "x", status: "DRAFT" }, drops }).phase, "before");
assert.equal(roomView({ sale: { title: "x", status: "ENDED" }, drops }).phase, "ended");
assert.equal(roomView({ sale: { title: "x", status: "LIVE" }, drops: drops.map((x) => ({ ...x, status: x.status === "OPEN" ? "CLOSED" : x.status })) }).phase, "between");
const before = roomView({ sale: { title: "x", status: "LIVE" }, drops }).version;
assert.notEqual(roomView({ sale: { title: "x", status: "LIVE" }, drops: drops.map((x) => (x.id === "b" ? { ...x, claimed: 3 } : x)) }).version, before, "the version changes with every claim");
assert.equal(roomView({ sale: { title: "x", status: "LIVE" }, drops: [] }).phase, "between", "an empty show doesn't crash");
assert.equal(roomView({ sale: { title: "x", status: "LIVE" }, drops: undefined }).upcoming.length, 0);
const many = Array.from({ length: 30 }, (_, i) => item("q" + i, i, "QUEUED", 0));
assert.equal(roomView({ sale: { title: "x", status: "LIVE" }, drops: many }).upcoming.length, 6, "only the next few are listed");
assert.equal(remaining({ quantity: 5, claimed: 7 }), 0);

// ---------- one invoice per shopper ----------
const claims = [{ dropId: "b", quantity: 1 }, { dropId: "a", quantity: 1 }, { dropId: "b", quantity: 1 }];
let inv = invoiceLines({ claims, drops });
assert.deepEqual(inv.lines.map((l) => [l.title, l.quantity, l.price]), [["Item a", 1, 25], ["Item b", 2, 25]], "combined per item, in show order");
assert.equal(inv.total, 75);
assert.equal(inv.lines[0].variantId, "gid://shopify/ProductVariant/a");
assert.deepEqual(invoiceLines({ claims: [], drops }), { lines: [], total: 0 });
assert.deepEqual(invoiceLines({ claims: [{ dropId: "gone", quantity: 3 }], drops }).lines, [], "a deleted item is skipped");
assert.equal(invoiceLines({ claims: [{ dropId: "a", quantity: 3 }], drops: [item("a", 1, "CLOSED", 3, { price: 19.99 })] }).total, 59.97, "cents add up exactly");
assert.deepEqual(invoiceLines({ claims: undefined, drops: undefined }), { lines: [], total: 0 });

console.log("Live Drops rules: all checks passed");
