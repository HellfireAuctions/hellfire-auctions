import assert from "node:assert/strict";
import { orphansToHide, APP_TYPE } from "../app/orphan-sweep.js";
import { sweepShop } from "../app/orphan-sweep.server.js";

const now = new Date("2026-10-08T00:00:00Z");
const ago = (min) => new Date(now.getTime() - min * 60_000).toISOString();
const P = (n, over = {}) => ({ id: `gid://shopify/Product/${n}`, status: "ACTIVE", productType: APP_TYPE, tags: [APP_TYPE, "Live Auction"], createdAt: ago(600), ...over });

// ---------- which products count as leftovers ----------
const known = new Set([P(1).id]);
assert.deepEqual(orphansToHide({ products: [P(1), P(2), P(3)], knownIds: known, now }), [P(2).id, P(3).id], "known auctions are never touched");

for (const [why, product] of [
  ["a draft product (already off the storefront)", P(9, { status: "DRAFT" })],
  ["an archived product", P(9, { status: "ARCHIVED" })],
  ["another product type", P(9, { productType: "Coral" })],
  ["no type", P(9, { productType: "" })],
  ["the type but not the tag", P(9, { tags: ["Live Auction"] })],
  ["no tags at all", P(9, { tags: [] })],
  ["tags not a list", P(9, { tags: "Hellfire Auction" })],
  ["created 29 minutes ago (an auction may still be being created)", P(9, { createdAt: ago(29) })],
  ["created just now", P(9, { createdAt: ago(0) })],
  ["no creation date", P(9, { createdAt: undefined })],
  ["a broken creation date", P(9, { createdAt: "yesterday-ish" })],
  ["no id", P(9, { id: undefined })],
]) {
  assert.deepEqual(orphansToHide({ products: [product], knownIds: new Set(), now }), [], why);
}
assert.deepEqual(orphansToHide({ products: [P(5, { createdAt: ago(31) })], knownIds: new Set(), now }), [P(5).id], "31 minutes old is old enough");
for (const bad of [null, undefined, "x", 5, {}, [null], [undefined], [{}]]) assert.deepEqual(orphansToHide({ products: bad, knownIds: new Set(), now }), [], JSON.stringify(bad));
assert.deepEqual(orphansToHide({ products: [P(2)], knownIds: undefined, now }), [P(2).id], "no known list means everything old counts");
assert.deepEqual(orphansToHide({ products: [P(1)], knownIds: [P(1).id], now }), [], "a plain array of known ids works too");

// ---------- the sweep itself, with Shopify and the database replaced ----------
function world({ pages, rows, failHide = [] }) {
  const calls = { lists: 0, hides: [] };
  const admin = {
    graphql: async (query, { variables }) => {
      if (query.includes("HellfireProducts")) {
        const i = calls.lists++;
        const page = pages[i] || { nodes: [], hasNext: false };
        return { json: async () => ({ data: { products: { pageInfo: { hasNextPage: page.hasNext, endCursor: "c" + i }, nodes: page.nodes } } }) };
      }
      calls.hides.push(variables.product);
      const bad = failHide.includes(variables.product.id);
      return { json: async () => ({ data: { productUpdate: { userErrors: bad ? [{ message: "nope" }] : [] } } }) };
    },
  };
  const asked = [];
  const db = { auction: { findMany: async (q) => { asked.push(q); return rows.map((productId) => ({ productId })); } } };
  return { admin, db, calls, asked };
}

let w = world({ pages: [{ nodes: [P(1), P(2), P(3, { createdAt: ago(5) }), P(4)], hasNext: false }], rows: [P(1).id] });
let r = await sweepShop("shop.myshopify.com", { admin: w.admin, db: w.db, now });
assert.equal(r.checked, 4);
assert.deepEqual(r.hidden, [P(2).id, P(4).id], "leftovers are hidden; the known auction and the brand-new product are not");
assert.deepEqual(w.calls.hides.map((h) => h.status), ["DRAFT", "DRAFT"], "hidden by making them drafts, never deleted");
assert.deepEqual(w.calls.hides.map((h) => Object.keys(h).sort().join()), ["id,status", "id,status"], "nothing else about the product is changed");
assert.equal(w.asked[0].where.shop, "shop.myshopify.com", "only this store's auctions are consulted");

// nothing to do: no database query, no changes
w = world({ pages: [{ nodes: [], hasNext: false }], rows: [] });
r = await sweepShop("s", { admin: w.admin, db: w.db, now });
assert.deepEqual(r, { checked: 0, hidden: [] });
assert.equal(w.asked.length, 0);

// everything known: nothing hidden
w = world({ pages: [{ nodes: [P(1), P(2)], hasNext: false }], rows: [P(1).id, P(2).id] });
r = await sweepShop("s", { admin: w.admin, db: w.db, now });
assert.deepEqual(r.hidden, []);
assert.equal(w.calls.hides.length, 0);

// several pages are read, up to the limit
w = world({ pages: [{ nodes: [P(10)], hasNext: true }, { nodes: [P(11)], hasNext: true }, { nodes: [P(12)], hasNext: false }], rows: [] });
r = await sweepShop("s", { admin: w.admin, db: w.db, now });
assert.equal(r.checked, 3);
assert.equal(w.calls.lists, 3);
w = world({ pages: Array.from({ length: 20 }, (_, i) => ({ nodes: [P(100 + i)], hasNext: true })), rows: [] });
r = await sweepShop("s", { admin: w.admin, db: w.db, now, maxPages: 5 });
assert.equal(w.calls.lists, 5, "never reads more than the page limit");

// one product that Shopify refuses doesn't stop the rest
w = world({ pages: [{ nodes: [P(1), P(2), P(3)], hasNext: false }], rows: [], failHide: [P(2).id] });
r = await sweepShop("s", { admin: w.admin, db: w.db, now });
assert.deepEqual(r.hidden, [P(1).id, P(3).id]);

// a failing product list is reported, not swallowed
const broken = { graphql: async () => ({ json: async () => ({ errors: [{ message: "Access denied" }] }) }) };
await assert.rejects(() => sweepShop("s", { admin: broken, db: { auction: { findMany: async () => [] } }, now }), /product list/);

// running it twice does nothing the second time (the first run made them drafts, so Shopify no longer lists them)
w = world({ pages: [{ nodes: [], hasNext: false }], rows: [] });
r = await sweepShop("s", { admin: w.admin, db: w.db, now });
assert.deepEqual(r.hidden, []);

console.log("Leftover product sweep: all checks passed");
