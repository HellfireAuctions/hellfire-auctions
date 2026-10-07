import assert from "node:assert/strict";
import { isSessionExpired, mayReauth, isNetworkError } from "../app/network-error.js";

// ---------- what counts as an expired Shopify session ----------
assert.equal(isSessionExpired({ status: 401, statusText: "Unauthorized", data: "" }), true, "a 401 answer from the server");
assert.equal(isSessionExpired(new Response(null, { status: 401 })), true, "a thrown Response");
for (const other of [{ status: 403 }, { status: 404 }, { status: 500 }, { status: 200 }, new Error("boom"), new TypeError("Failed to fetch"), null, undefined, "401", 401, {}]) {
  assert.equal(isSessionExpired(other), false, JSON.stringify(other) || String(other));
}
// the two kinds of "reconnect" never overlap
assert.equal(isNetworkError({ status: 401 }), false);
assert.equal(isSessionExpired(new TypeError("Failed to fetch")), false);

// ---------- the reload guard: never a loop ----------
const now = 1_800_000_000_000;
assert.equal(mayReauth(null, now), true, "never tried before");
assert.equal(mayReauth(undefined, now), true);
assert.equal(mayReauth("", now), true);
assert.equal(mayReauth("garbage", now), true, "unreadable storage counts as never tried");
assert.equal(mayReauth(String(now - 1_000), now), false, "just tried: do not reload again");
assert.equal(mayReauth(String(now - 29_000), now), false);
assert.equal(mayReauth(String(now - 31_000), now), true, "long enough ago: one more try is fine");
assert.equal(mayReauth(now - 5_000, now), false, "numbers work as well as text");

console.log("Expired Shopify session: all checks passed");
