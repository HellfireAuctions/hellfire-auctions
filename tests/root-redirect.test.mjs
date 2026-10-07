import assert from "node:assert/strict";
import { shouldOpenApp } from "../app/root-redirect.js";

const base = "https://hellfire-auctions.onrender.com/";

// ---------- Shopify's admin always gets sent on to the app ----------
assert.equal(shouldOpenApp(base + "?shop=hellfire-auctions-dev.myshopify.com"), true, "the usual install/open link");
assert.equal(shouldOpenApp(base + "?embedded=1&hmac=abc&host=YWRtaW4&shop=x.myshopify.com&timestamp=1"), true, "the full admin link");
assert.equal(shouldOpenApp(base + "?embedded=1"), true, "embedded flag alone");
assert.equal(shouldOpenApp(base + "?host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvdGVzdA"), true, "host alone");
assert.equal(shouldOpenApp(base + "?id_token=eyJhbGciOi"), true, "a session token alone");
assert.equal(shouldOpenApp(base, "iframe"), true, "anything loading inside the admin's frame, even with nothing after the address");
assert.equal(shouldOpenApp(base, "IFRAME"), true, "case does not matter");

// ---------- ordinary visitors see the public page ----------
assert.equal(shouldOpenApp(base), false);
assert.equal(shouldOpenApp(base, "document"), false, "a normal browser tab");
assert.equal(shouldOpenApp(base, "navigate"), false);
assert.equal(shouldOpenApp(base, null), false);
assert.equal(shouldOpenApp(base, undefined), false);
assert.equal(shouldOpenApp(base + "?utm_source=newsletter&ref=friend"), false, "tracking links stay on the public page");
assert.equal(shouldOpenApp(base + "?embedded=0"), false);
assert.equal(shouldOpenApp(base + "?shop="), false, "an empty shop is not a shop");

// ---------- garbage never crashes the front door ----------
assert.equal(shouldOpenApp("not a url"), false);
assert.equal(shouldOpenApp(""), false);
assert.equal(shouldOpenApp(null), false);

console.log("App front door: all checks passed");
