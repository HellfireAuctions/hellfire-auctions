import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The storefront runtime must never climb to the whole page when it hides a price/cart on an auction card.
// Regression: a link to an auction product with no price beside it made it mark <body> and hide EVERY price on the store.
const js = readFileSync(new URL("../extensions/hellfire-auctions-storefront/assets/auction-runtime-v4.js", import.meta.url), "utf8");

assert.ok(js.includes('a===document.body||a===document.documentElement||a.tagName==="MAIN"'), "must stop before body/html/main");
assert.ok(js.includes("hs.size>1)break"), "must stop at any container holding more than one product");
const guard = js.indexOf("hs.size>1)break");
const hide = js.indexOf("n.forEach(i),a.setAttribute(E");
assert.ok(guard > 0 && hide > guard, "the guard must run before anything is hidden");
console.log("price-hide-scope ok");
