import assert from "node:assert/strict";
import { liveToken, validLiveToken } from "../app/live-token.js";

const S = "secret-one";
const HOUR = 60 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 6, 12, 0, 0); // exactly the start of an hour

const token = liveToken("auction-1", S, t0);
assert.match(token, /^[0-9a-f]{40}$/, "a 40-character code");

// the same all through the hour (so the browser keeps one connection), different the next hour
assert.equal(liveToken("auction-1", S, t0 + 59 * 60_000), token);
assert.equal(liveToken("auction-1", S, t0 + HOUR - 1), token);
assert.notEqual(liveToken("auction-1", S, t0 + HOUR), token);

// valid for the hour it was issued and the next one, then it expires
assert.equal(validLiveToken("auction-1", token, t0, S), true);
assert.equal(validLiveToken("auction-1", token, t0 + 30 * 60_000, S), true);
assert.equal(validLiveToken("auction-1", token, t0 + HOUR, S), true, "still valid in the following hour");
assert.equal(validLiveToken("auction-1", token, t0 + 2 * HOUR - 1, S), true, "valid to the last second of that hour");
assert.equal(validLiveToken("auction-1", token, t0 + 2 * HOUR, S), false, "expired after two hours");
assert.equal(validLiveToken("auction-1", token, t0 + 5 * HOUR, S), false);
assert.equal(validLiveToken("auction-1", token, t0 - HOUR, S), false, "not valid before it was issued");

// only for the auction it was issued for
assert.equal(validLiveToken("auction-2", token, t0, S), false);
assert.equal(validLiveToken("auction-1 ", token, t0, S), false);
assert.notEqual(liveToken("auction-2", S, t0), token);

// only with the right secret
assert.equal(validLiveToken("auction-1", token, t0, "another-secret"), false);
assert.notEqual(liveToken("auction-1", "another-secret", t0), token);

// garbage is refused without errors
for (const bad of ["", "abc", token.slice(1), token + "0", token.toUpperCase(), token.replace(/.$/, token.endsWith("0") ? "1" : "0"), null, undefined, 12345, {}, [], "x".repeat(40)]) {
  assert.equal(validLiveToken("auction-1", bad, t0, S), false, String(bad));
}

// nothing is issued or accepted without a secret or an auction
assert.equal(liveToken("auction-1", "", t0), "");
assert.equal(liveToken("auction-1", undefined, t0), "");
assert.equal(liveToken("", S, t0), "");
assert.equal(validLiveToken("auction-1", token, t0, ""), false);
assert.equal(validLiveToken("auction-1", token, t0, undefined), false);
assert.equal(validLiveToken("", token, t0, S), false);

console.log("Live passes: all checks passed");
