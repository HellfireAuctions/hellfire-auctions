import assert from "node:assert/strict";
import fs from "node:fs";
import { syncDropStock, ensureStockForSale } from "../app/drop-stock.server.js";

// A pretend Shopify that records every request.
function fakeAdmin({ location = "gid://shopify/Location/1", variant = true, trackErrors = [], setErrors = [], explode = false } = {}) {
  const calls = [];
  const reply = (data) => ({ json: async () => ({ data }) });
  return {
    calls,
    graphql: async (query, opts = {}) => {
      if (explode) throw new Error("network down");
      calls.push({ query, variables: opts.variables });
      if (query.includes("DropStockLookup")) return reply({ product: variant ? { variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", inventoryItem: { id: "gid://shopify/InventoryItem/7" } }] } } : null, locations: { nodes: location ? [{ id: location }] : [] } });
      if (query.includes("DropTrack(")) return reply({ productVariantsBulkUpdate: { userErrors: trackErrors } });
      if (query.includes("DropStock(")) return reply({ inventorySetQuantities: { userErrors: setErrors } });
      throw new Error("unexpected request");
    },
  };
}
const P = "gid://shopify/Product/5";

// ---------- the happy path: tracked, and set to the quantity for sale ----------
let admin = fakeAdmin();
let r = await syncDropStock({ admin, productId: P, quantity: 10, uuid: () => "key-1" });
assert.deepEqual(r, { ok: true, locationId: "gid://shopify/Location/1", quantity: 10 });
assert.equal(admin.calls.length, 3, "look up, turn tracking on, set the stock");
assert.ok(admin.calls[0].query.includes("DropStockLookup") && admin.calls[0].variables.id === P, "finds this item's product");
const track = admin.calls[1].variables;
assert.equal(track.productId, P);
assert.deepEqual(track.variants, [{ id: "gid://shopify/ProductVariant/9", inventoryPolicy: "CONTINUE", inventoryItem: { tracked: true } }], "stock tracking on, and a paying shopper is never blocked");
const set = admin.calls[2];
assert.ok(set.query.includes("@idempotent"), "a repeated request can never double the stock");
assert.equal(set.variables.idempotencyKey, "key-1");
assert.deepEqual(set.variables.input, { name: "available", reason: "correction", quantities: [{ inventoryItemId: "gid://shopify/InventoryItem/7", locationId: "gid://shopify/Location/1", quantity: 10, changeFromQuantity: null }] }, "available stock equals the quantity for sale");
assert.ok(admin.calls[1].query.indexOf("DropTrack") > 0 && admin.calls.indexOf(admin.calls[1]) < admin.calls.indexOf(set), "tracking is turned on BEFORE the stock is set (Shopify refuses stock on an untracked item)");

// ---------- odd quantities ----------
for (const [given, expected] of [[7.9, 7], [-3, 0], ["5", 5], [0, 0], [undefined, 0], ["abc", 0], [1000, 1000]]) {
  admin = fakeAdmin();
  await syncDropStock({ admin, productId: P, quantity: given });
  assert.equal(admin.calls[2].variables.input.quantities[0].quantity, expected, `quantity ${String(given)} becomes ${expected}`);
}
admin = fakeAdmin();
await syncDropStock({ admin, productId: P, quantity: 1 });
await syncDropStock({ admin, productId: P, quantity: 1 });
assert.notEqual(admin.calls[2].variables.idempotencyKey, admin.calls[5].variables.idempotencyKey, "each real request gets its own key");

// ---------- things that go wrong never throw, and say why ----------
admin = fakeAdmin({ variant: false });
r = await syncDropStock({ admin, productId: P, quantity: 5 });
assert.deepEqual([r.ok, r.reason], [false, "the product could not be found"]);
assert.equal(admin.calls.length, 1, "nothing else is attempted");
admin = fakeAdmin({ location: null });
r = await syncDropStock({ admin, productId: P, quantity: 5 });
assert.deepEqual([r.ok, r.reason], [false, "the store has no stock location"]);
assert.equal(admin.calls.length, 1);
admin = fakeAdmin({ trackErrors: [{ message: "Inventory tracking is not allowed" }] });
r = await syncDropStock({ admin, productId: P, quantity: 5 });
assert.deepEqual([r.ok, r.reason], [false, "Inventory tracking is not allowed"]);
assert.equal(admin.calls.length, 2, "the stock is not set when tracking could not be turned on");
admin = fakeAdmin({ setErrors: [{ message: "Location is inactive" }, { message: "second problem" }] });
r = await syncDropStock({ admin, productId: P, quantity: 5 });
assert.deepEqual([r.ok, r.reason], [false, "Location is inactive, second problem"]);
r = await syncDropStock({ admin: fakeAdmin({ explode: true }), productId: P, quantity: 5 });
assert.deepEqual([r.ok, r.reason], [false, "network down"], "a network problem never throws");

// ---------- items added earlier are set up when a show starts ----------
function fakeDb(drops) {
  return {
    actionDrop: {
      findMany: async ({ where }) => drops.filter((d) => d.saleId === where.saleId && d.shop === where.shop && d.stockSynced === where.stockSynced),
      update: async ({ where, data }) => Object.assign(drops.find((d) => d.id === where.id), data),
    },
  };
}
const item = (id, over = {}) => ({ id, saleId: "s1", shop: "a.myshopify.com", productId: "gid://shopify/Product/" + id, quantity: 10, stockSynced: false, ...over });
const drops = [item("1"), item("2", { stockSynced: true }), item("3", { quantity: 4 }), item("4", { saleId: "other" }), item("5", { shop: "b.myshopify.com" })];
const synced = [];
let out = await ensureStockForSale({ shop: "a.myshopify.com", saleId: "s1", admin: {}, db: fakeDb(drops), sync: async ({ productId, quantity }) => { synced.push([productId.split("/").pop(), quantity]); return { ok: true }; } });
assert.deepEqual(synced, [["1", 10], ["3", 4]], "only this show's items that are not set up yet, with their own quantities");
assert.deepEqual(out, { synced: 2, failed: 0 });
assert.deepEqual([drops[0].stockSynced, drops[2].stockSynced, drops[3].stockSynced, drops[4].stockSynced], [true, true, false, false], "marked done, and no other show or store is touched");
out = await ensureStockForSale({ shop: "a.myshopify.com", saleId: "s1", admin: {}, db: fakeDb(drops), sync: async () => { throw new Error("must not run again"); } });
assert.deepEqual(out, { synced: 0, failed: 0 }, "nothing left to do the second time");
const retry = [item("7"), item("8")];
out = await ensureStockForSale({ shop: "a.myshopify.com", saleId: "s1", admin: {}, db: fakeDb(retry), sync: async ({ productId }) => (productId.endsWith("/7") ? { ok: false, reason: "no location" } : { ok: true }) });
assert.deepEqual(out, { synced: 1, failed: 1 }, "one failure does not stop the next item");
assert.deepEqual([retry[0].stockSynced, retry[1].stockSynced], [false, true], "a failed item is tried again next time");
out = await ensureStockForSale({ shop: "a.myshopify.com", saleId: "s1", admin: {}, db: { actionDrop: { findMany: async () => { throw new Error("db down"); } } } });
assert.deepEqual(out, { synced: 0, failed: 0 }, "a database problem never stops the show");

// ---------- it is really wired in (so it cannot be forgotten) ----------
const product = fs.readFileSync("app/drop-product.server.js", "utf8");
assert.ok(product.includes("syncDropStock({ admin, productId, quantity })") && product.includes("createDropProduct({ admin, title, price, quantity, imageFile })"), "a new item's product has its stock set when it is created");
const app = fs.readFileSync("app/routes/app.live.jsx", "utf8");
assert.ok(app.includes("quantity: parsed.item.quantity") && app.includes("stockSynced: Boolean(made.stock?.ok)"), "the host screen passes the quantity and records the result");
for (const intent of ['intent === "start"', 'intent === "go"', 'intent === "next"']) {
  const from = app.indexOf(intent);
  assert.ok(app.slice(from, from + 900).includes("ensureStockForSale({ shop, saleId, admin })"), `starting a show or opening an item (${intent}) sets up any missing stock`);
}
const studio = fs.readFileSync("app/routes/api.studio.jsx", "utf8");
assert.equal((studio.match(/ensureStockForShop\(\{ shop, saleId \}\)/g) || []).length, 3, "and so does the phone Studio");
const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
assert.ok(/stockSynced\s+Boolean\s+@default\(false\)/.test(schema), "the database remembers which items are set up");

console.log("Live Drops stock: all checks passed");
