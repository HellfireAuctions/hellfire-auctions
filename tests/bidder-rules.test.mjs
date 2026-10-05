import assert from "node:assert/strict";
import { decide, cleanTag, MESSAGES, BIDDER_RULES, BIDDER_RULE_VALUES, DEFAULT_APPROVED_TAG } from "../app/bidder-rules.js";

const ok = { ok: true };
const denied = (message) => ({ ok: false, message });

// the default: anyone signed in, no questions asked (even if Shopify knows nothing about them)
assert.deepEqual(decide("ANYONE", "x", null), ok);
assert.deepEqual(decide("ANYONE", "x", { verifiedEmail: false, numberOfOrders: "0", tags: [] }), ok);

// a corrupted or unknown setting never locks a merchant out
assert.deepEqual(decide("SOMETHING_ELSE", "x", null), ok);
assert.deepEqual(decide(undefined, "x", null), ok);
assert.deepEqual(decide("", "x", null), ok);

// verified email
assert.deepEqual(decide("VERIFIED_EMAIL", "", { verifiedEmail: true }), ok);
assert.deepEqual(decide("VERIFIED_EMAIL", "", { verifiedEmail: false }), denied(MESSAGES.VERIFIED_EMAIL));
assert.deepEqual(decide("VERIFIED_EMAIL", "", { verifiedEmail: null }), denied(MESSAGES.VERIFIED_EMAIL));
assert.deepEqual(decide("VERIFIED_EMAIL", "", {}), denied(MESSAGES.VERIFIED_EMAIL), "missing means not verified");

// repeat buyers (Shopify reports the count as a string)
assert.deepEqual(decide("PAST_BUYER", "", { numberOfOrders: "1" }), ok);
assert.deepEqual(decide("PAST_BUYER", "", { numberOfOrders: "27" }), ok);
assert.deepEqual(decide("PAST_BUYER", "", { numberOfOrders: 3 }), ok);
assert.deepEqual(decide("PAST_BUYER", "", { numberOfOrders: "0" }), denied(MESSAGES.PAST_BUYER));
assert.deepEqual(decide("PAST_BUYER", "", { numberOfOrders: 0 }), denied(MESSAGES.PAST_BUYER));
assert.deepEqual(decide("PAST_BUYER", "", {}), denied(MESSAGES.PAST_BUYER));
assert.deepEqual(decide("PAST_BUYER", "", { numberOfOrders: "abc" }), denied(MESSAGES.PAST_BUYER));

// approved by tag (any capitalisation, any spacing)
assert.deepEqual(decide("APPROVED_TAG", "vip", { tags: ["VIP", "wholesale"] }), ok);
assert.deepEqual(decide("APPROVED_TAG", "VIP", { tags: ["vip"] }), ok);
assert.deepEqual(decide("APPROVED_TAG", "vip", { tags: [" Vip "] }), ok);
assert.deepEqual(decide("APPROVED_TAG", "vip", { tags: ["vip-gold"] }), denied(MESSAGES.APPROVED_TAG), "a different tag is not the same tag");
assert.deepEqual(decide("APPROVED_TAG", "vip", { tags: [] }), denied(MESSAGES.APPROVED_TAG));
assert.deepEqual(decide("APPROVED_TAG", "vip", {}), denied(MESSAGES.APPROVED_TAG));
assert.deepEqual(decide("APPROVED_TAG", "", { tags: [DEFAULT_APPROVED_TAG] }), ok, "an empty tag setting falls back to the default tag");
assert.deepEqual(decide("APPROVED_TAG", "<script>", { tags: [DEFAULT_APPROVED_TAG] }), ok, "an invalid tag setting falls back to the default tag");

// when Shopify could not find the customer, any real rule asks them to try again
for (const rule of ["VERIFIED_EMAIL", "PAST_BUYER", "APPROVED_TAG"]) {
  assert.deepEqual(decide(rule, "vip", null), denied(MESSAGES.unavailable), rule);
  assert.deepEqual(decide(rule, "vip", undefined), denied(MESSAGES.unavailable), rule);
}

// tag cleaning
assert.equal(cleanTag("bidder-approved"), "bidder-approved");
assert.equal(cleanTag("  Gold   Member "), "Gold Member");
assert.equal(cleanTag("café-club"), "café-club");
assert.equal(cleanTag("VIP_2026:a.b"), "VIP_2026:a.b");
assert.equal(cleanTag("a".repeat(60)), "a".repeat(40), "long tags are shortened");
assert.equal(cleanTag("<script>alert(1)</script>"), "");
assert.equal(cleanTag("tag,with,commas"), "");
assert.equal(cleanTag("quote\"s"), "");
assert.equal(cleanTag(""), "");
assert.equal(cleanTag(null), "");
assert.equal(cleanTag(undefined), "");

// the choices and messages the app shows
assert.deepEqual(BIDDER_RULE_VALUES, ["ANYONE", "VERIFIED_EMAIL", "PAST_BUYER", "APPROVED_TAG"]);
assert.ok(BIDDER_RULE_VALUES.every((v) => typeof BIDDER_RULES[v] === "string" && BIDDER_RULES[v].length > 5));
const texts = Object.values(MESSAGES);
assert.equal(new Set(texts).size, texts.length, "every message is different");
assert.ok(texts.every((m) => m.length > 20 && !m.includes("undefined")));

console.log("Bidder rules: all checks passed");
