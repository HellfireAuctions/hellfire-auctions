import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../extensions/hellfire-auctions-storefront/assets/auction-runtime-v4.js", import.meta.url),
  "utf8",
);

// Safety net: the runtime must be able to detect it is hiding too many prices and restore them.
assert.ok(src.includes("price-hiding safety stop"), "circuit breaker message missing");
assert.ok(src.includes("p.length>6*Math.max(a.size,1)+2"), "circuit breaker threshold missing");
assert.ok(src.includes('K&&e.matches&&e.matches(PS)'), "hide helper must refuse prices once the breaker has tripped");
assert.ok(src.includes("m=()=>{K||("), "main loop must stop once the breaker has tripped");
// Climb guard from the original fix must still be present.
assert.ok(src.includes("hs.size>1)break"), "climb guard missing");
console.log("price-breaker: ok");
