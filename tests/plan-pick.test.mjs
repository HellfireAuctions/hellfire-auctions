import assert from "node:assert/strict";
import fs from "node:fs";
import { markSubscriptionCancelled, isRecentlyCancelled, pickActiveSubscription, resetCancelledForTests } from "../app/plan-pick.js";

const inferno = { id: "gid://shopify/AppSubscription/111", name: "Hellfire Auctions Inferno", status: "ACTIVE" };
const blaze = { id: "gid://shopify/AppSubscription/222", name: "Hellfire Auctions Blaze", status: "ACTIVE" };
const T0 = 1_000_000_000_000;

// normal: the active plan is the plan
assert.equal(pickActiveSubscription([inferno], { shop: "a.myshopify.com", now: T0 }), inferno);
assert.equal(pickActiveSubscription([], { shop: "a.myshopify.com", now: T0 }), null, "nothing active means Spark");
assert.equal(pickActiveSubscription(undefined, { shop: "a.myshopify.com", now: T0 }), null);
assert.equal(pickActiveSubscription([{ ...inferno, status: "CANCELLED" }, { ...blaze, status: "DECLINED" }], { shop: "a.myshopify.com", now: T0 }), null, "only ACTIVE counts");

// THE BUG: we just cancelled Inferno, but Shopify still lists it as ACTIVE for a few seconds
markSubscriptionCancelled("a.myshopify.com", inferno.id, T0);
assert.equal(isRecentlyCancelled("a.myshopify.com", inferno.id, T0 + 1000), true);
assert.equal(pickActiveSubscription([inferno], { shop: "a.myshopify.com", now: T0 + 1000 }), null, "a subscription we just cancelled is not the plan, even if Shopify still says ACTIVE");
assert.equal(pickActiveSubscription([inferno], { shop: "a.myshopify.com", now: T0 + 14 * 60 * 1000 }), null, "still remembered for 14 minutes");
assert.equal(isRecentlyCancelled("a.myshopify.com", "111", T0 + 1000), true, "the bare charge number matches the full id");
// it is only remembered for a while, then Shopify is trusted again (e.g. the merchant resubscribed to the same plan)
assert.equal(pickActiveSubscription([inferno], { shop: "a.myshopify.com", now: T0 + 16 * 60 * 1000 }), inferno, "after 15 minutes Shopify is trusted again");
// another store is unaffected, and so is a different subscription
assert.equal(pickActiveSubscription([inferno], { shop: "b.myshopify.com", now: T0 + 1000 }), inferno, "another store is unaffected");
resetCancelledForTests();
markSubscriptionCancelled("a.myshopify.com", inferno.id, T0);
assert.equal(pickActiveSubscription([inferno, blaze], { shop: "a.myshopify.com", now: T0 + 1000 }), blaze, "the other, new subscription is the plan");

// right after an approval two subscriptions can both look active: the one just approved wins
resetCancelledForTests();
assert.equal(pickActiveSubscription([inferno, blaze], { shop: "a.myshopify.com", chargeId: "222", now: T0 }), blaze, "the charge Shopify just sent us back with wins (downgrade settling)");
assert.equal(pickActiveSubscription([blaze, inferno], { shop: "a.myshopify.com", chargeId: "gid://shopify/AppSubscription/111", now: T0 }), inferno, "a full id works too (upgrade settling)");
assert.equal(pickActiveSubscription([inferno], { shop: "a.myshopify.com", chargeId: "999", now: T0 }), inferno, "an unknown charge id is ignored");

// ---------- it is really wired in ----------
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const server = read("app/plans.server.js");
assert.ok(server.includes("pickActiveSubscription(appSubscriptions, { shop, chargeId })"), "the sync uses the rule");
assert.ok(!server.includes('.find((s) => s.status === "ACTIVE")'), "and no longer trusts the raw list");
assert.ok(server.includes("findApprovedCharge(admin, shop, chargeId)") && server.includes("... on AppSubscription"), "after an approval it asks Shopify about that exact charge");
const route = read("app/routes/app.plans.jsx");
assert.ok(route.includes('searchParams.get("charge_id")') && route.includes("shop: session.shop, chargeId"), "the plans page passes the approved charge");
const cancel = route.indexOf("await billing.cancel(");
assert.ok(cancel > 0 && route.indexOf("markSubscriptionCancelled(session.shop, subscription.id)") > cancel, "a cancellation is remembered straight after it is made");
assert.ok(route.indexOf("markSubscriptionCancelled(session.shop") < route.indexOf('await setShopPlan(session.shop, "SPARK"'), "before the plan is set to Spark");
console.log("Plan selection: all checks passed");
