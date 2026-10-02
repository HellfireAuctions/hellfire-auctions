import { authenticate } from "../shopify.server";
import { planKeyFromBillingName, setShopPlan } from "../plans.server";
import db from "../db.server";

// Shopify tells us whenever a subscription is approved, cancelled, frozen or expires.
export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  const sub = payload?.app_subscription || {};
  const status = String(sub.status || "").toUpperCase();
  const id = sub.admin_graphql_api_id || null;

  if (status === "ACTIVE") {
    await setShopPlan(shop, planKeyFromBillingName(sub.name), id);
  } else {
    // Only downgrade if the subscription that ended is the one we have on file.
    const row = await db.shopPlan.findUnique({ where: { shop } }).catch(() => null);
    if (!row?.subscriptionId || row.subscriptionId === id) {
      await setShopPlan(shop, "SPARK", null);
    }
  }
  console.log(`[billing] ${topic} for ${shop}: ${sub.name || "?"} -> ${status}`);
  return new Response();
};
