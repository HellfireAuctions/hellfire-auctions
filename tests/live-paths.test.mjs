import assert from "node:assert/strict";
import { pathsFromNodes } from "../app/live-paths.js";

const A = "gid://shopify/Product/1";
const B = "gid://shopify/Product/2";
const C = "gid://shopify/Product/3";

// ---------- the normal answer ----------
let m = pathsFromNodes([{ id: A, status: "ACTIVE", handle: "reviewers-test-product", onlineStoreUrl: "https://hellfire-auctions-dev.myshopify.com/products/reviewers-test-product" }]);
assert.equal(m.get(A), "/products/reviewers-test-product", "the Online Store address wins");
// the address on a custom domain or a translated store keeps its own path
m = pathsFromNodes([{ id: A, status: "ACTIVE", handle: "x", onlineStoreUrl: "https://shop.example.com/fr/products/x" }]);
assert.equal(m.get(A), "/fr/products/x");

// ---------- Shopify gives no address: use the handle ----------
m = pathsFromNodes([{ id: A, status: "ACTIVE", handle: "testy-lil-tester", onlineStoreUrl: null }]);
assert.equal(m.get(A), "/products/testy-lil-tester", "this is the case that left the bubble empty");
m = pathsFromNodes([{ id: A, status: "ACTIVE", handle: "testy-lil-tester" }]);
assert.equal(m.get(A), "/products/testy-lil-tester", "the field missing altogether");
m = pathsFromNodes([{ id: A, status: "ACTIVE", handle: "abc", onlineStoreUrl: "not a url" }]);
assert.equal(m.get(A), "/products/abc", "a broken address falls back to the handle");

// ---------- what is left out ----------
m = pathsFromNodes([
  { id: A, status: "DRAFT", handle: "draft-one", onlineStoreUrl: "https://s.example.com/products/draft-one" },
  { id: B, status: "ARCHIVED", handle: "archived-one" },
  { id: C, status: "ACTIVE", handle: "../etc/passwd" },
  null,
  undefined,
  {},
  { status: "ACTIVE", handle: "no-id" },
  { id: "gid://shopify/Product/9", status: "ACTIVE" },
  { id: "gid://shopify/Product/10", status: "ACTIVE", handle: "" },
  { id: "gid://shopify/Product/11", status: "ACTIVE", handle: "has space" },
  { id: "gid://shopify/Product/12", status: "ACTIVE", handle: "<script>" },
]);
assert.equal(m.size, 0, "inactive products, odd handles and incomplete answers are all left out");

// ---------- odd answers never crash ----------
for (const bad of [null, undefined, "nodes", 5, {}, [], [null]]) assert.equal(pathsFromNodes(bad).size, 0, JSON.stringify(bad));

// ---------- a mixed list ----------
m = pathsFromNodes([{ id: A, status: "ACTIVE", handle: "one" }, { id: B, status: "DRAFT", handle: "two" }, { id: C, status: "ACTIVE", handle: "three", onlineStoreUrl: "https://s.example.com/products/three" }]);
assert.deepEqual([...m], [[A, "/products/one"], [C, "/products/three"]]);

console.log("Live auction links: all checks passed");
