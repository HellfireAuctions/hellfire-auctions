import assert from "node:assert/strict";
import { needsPlanChoice, confirmOnSync } from "../app/plan-choice.js";

const when = new Date("2026-10-08T01:00:00Z");

// ---------- who is asked to choose ----------
assert.equal(needsPlanChoice({ complimentary: false, row: null }), true, "a brand-new store has no plan record: ask");
assert.equal(needsPlanChoice({ complimentary: false, row: undefined }), true);
assert.equal(needsPlanChoice({ complimentary: false, row: { plan: "SPARK", planConfirmedAt: null } }), true, "a Spark record that was only created by looking at the Plans page is not a choice");
assert.equal(needsPlanChoice({ complimentary: false, row: { plan: "SPARK" } }), true, "a record from before this existed, with nothing confirmed");
assert.equal(needsPlanChoice({ complimentary: false, row: { plan: "SPARK", planConfirmedAt: when } }), false, "Spark picked on purpose");
assert.equal(needsPlanChoice({ complimentary: false, row: { plan: "INFERNO", planConfirmedAt: when } }), false, "a paid plan, active on Shopify");
assert.equal(needsPlanChoice({ complimentary: true, row: null }), false, "free-forever stores are never asked");
assert.equal(needsPlanChoice({ complimentary: true, row: { plan: "SPARK", planConfirmedAt: null } }), false);

// ---------- what Shopify's answer confirms ----------
assert.equal(confirmOnSync({ id: "gid://shopify/AppSubscription/1", status: "ACTIVE" }), true, "an active paid subscription is a choice");
assert.equal(confirmOnSync(null), false, "no subscription: not a choice (the merchant may never have been asked)");
assert.equal(confirmOnSync(undefined), false);

// ---------- the journeys ----------
// 1. new store -> opens the app -> asked -> picks Spark -> not asked again
let row = null;
assert.equal(needsPlanChoice({ complimentary: false, row }), true);
row = { plan: "SPARK", planConfirmedAt: when };
assert.equal(needsPlanChoice({ complimentary: false, row }), false);
// 2. new store -> starts a paid plan but abandons Shopify's approval page -> still asked
row = { plan: "SPARK", planConfirmedAt: null };
assert.equal(needsPlanChoice({ complimentary: false, row }), true);
// 3. paid plan approved -> sync sees it active -> chosen
assert.equal(confirmOnSync({ status: "ACTIVE" }), true);
// 4. a paid plan is later cancelled: the record goes back to Spark but stays chosen (the code only ever sets, never clears)
row = { plan: "SPARK", planConfirmedAt: when };
assert.equal(needsPlanChoice({ complimentary: false, row }), false);

console.log("Plan first: all checks passed");
