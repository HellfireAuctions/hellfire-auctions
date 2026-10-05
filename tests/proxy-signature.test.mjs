import assert from "node:assert/strict";
import crypto from "node:crypto";
import { shopifyApi } from "@shopify/shopify-api";
import { ApiVersion } from "@shopify/shopify-app-react-router/server";
import "@shopify/shopify-api/adapters/node";
import { validSignature, SHOP_PATTERN } from "../app/proxy-signature.js";

const SECRET = "test-secret-123";
const nowSec = Math.floor(Date.now() / 1000);

function signed(params, secret = SECRET) {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  const signature = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return "?" + new URLSearchParams({ ...params, signature }).toString();
}
const base = { shop: "hellfire-auctions-dev.myshopify.com", path_prefix: "/apps/hellfire-auctions", timestamp: String(nowSec), logged_in_customer_id: "123", product_id: "999" };

// Shopify's own library is the referee: the fast check must agree with it on every case
const api = shopifyApi({ apiKey: "key", apiSecretKey: SECRET, scopes: ["read_products"], hostName: "example.com", apiVersion: ApiVersion.July26, isEmbeddedApp: true });
async function shopifyAgrees(search) {
  let theirs;
  try {
    theirs = await api.utils.validateHmac(Object.fromEntries(new URLSearchParams(search).entries()), { signator: "appProxy" });
  } catch {
    theirs = false;
  }
  return theirs;
}
async function bothSay(name, search, expected) {
  const mine = validSignature(search, SECRET);
  const theirs = await shopifyAgrees(search);
  assert.equal(mine, expected, `${name}: fast check said ${mine}, expected ${expected}`);
  assert.equal(theirs, expected, `${name}: Shopify's library said ${theirs}, expected ${expected}`);
}

await bothSay("a correctly signed request", signed(base), true);
await bothSay("a signed request with no customer", signed({ shop: base.shop, path_prefix: base.path_prefix, timestamp: base.timestamp }), true);
await bothSay("a value that needs URL encoding", signed({ ...base, note: "a b&c=d/é" }), true);
await bothSay("an empty value", signed({ ...base, empty: "" }), true);
await bothSay("a tampered customer id", signed(base).replace("logged_in_customer_id=123", "logged_in_customer_id=124"), false);
await bothSay("a tampered shop", signed(base).replace("hellfire-auctions-dev", "someone-elses-store"), false);
await bothSay("an added parameter", signed(base) + "&extra=1", false);
await bothSay("a removed parameter", signed(base).replace("&product_id=999", ""), false);
await bothSay("the wrong secret", signed(base, "another-secret"), false);
await bothSay("no signature at all", "?" + new URLSearchParams(base).toString(), false);
await bothSay("an empty signature", "?" + new URLSearchParams({ ...base, signature: "" }).toString(), false);
await bothSay("a garbage signature", "?" + new URLSearchParams({ ...base, signature: "zzzz" }).toString(), false);
await bothSay("an old timestamp (5 minutes ago)", signed({ ...base, timestamp: String(nowSec - 300) }), false);
await bothSay("a future timestamp (5 minutes ahead)", signed({ ...base, timestamp: String(nowSec + 300) }), false);

// the edges of the 90-second window (checked on the fast path with a controlled clock)
assert.equal(validSignature(signed({ ...base, timestamp: "1000" }), SECRET, 1089), true);
assert.equal(validSignature(signed({ ...base, timestamp: "1000" }), SECRET, 1091), false);
assert.equal(validSignature(signed({ ...base, timestamp: "1000" }), SECRET, 909), false);
assert.equal(validSignature(signed({ ...base, timestamp: "1000" }), SECRET, 910), true);
assert.equal(validSignature(signed({ ...base, timestamp: "abc" }), SECRET), false, "a timestamp that is not a number");

// no secret configured means nothing is accepted
assert.equal(validSignature(signed(base), ""), false);
assert.equal(validSignature(signed(base), undefined), false);

// repeated parameter names: values are joined with commas, as Shopify documents
const repeated = `?a=1&a=2&shop=x.myshopify.com&timestamp=${nowSec}`;
const sig = crypto.createHmac("sha256", SECRET).update(`a=1,2shop=x.myshopify.comtimestamp=${nowSec}`).digest("hex");
assert.equal(validSignature(repeated + "&signature=" + sig, SECRET), true);

// the store address must look like a Shopify store
for (const good of ["hellfire-auctions-dev.myshopify.com", "onlyultrafrags.myshopify.com", "a1.myshopify.com"]) assert.ok(SHOP_PATTERN.test(good), good);
for (const bad of ["evil.com", "x.myshopify.com.evil.com", "-x.myshopify.com", "x y.myshopify.com", ".myshopify.com", "", "x.myshopify.com/path"]) assert.ok(!SHOP_PATTERN.test(bad), bad);

console.log("Proxy signature check: all checks passed, and Shopify's own library agrees on every case");
