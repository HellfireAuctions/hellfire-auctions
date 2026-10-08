// Hellfire Auctions plans: Spark (free), Blaze ($10/mo), Inferno ($30/mo).
import prisma from "./db.server.js";
import { needsPlanChoice, confirmOnSync } from "./plan-choice.js";

import { BILLING_NAMES, PLANS, HOT_BID_THRESHOLD, TRIAL_DAYS } from "./plans.shared.js";

export { BILLING_NAMES, PLANS, HOT_BID_THRESHOLD, TRIAL_DAYS };

// Stores listed in COMPLIMENTARY_SHOPS (comma-separated) get Inferno for free (e.g. the app owner's own store).
function isComplimentary(shop) {
  return (process.env.COMPLIMENTARY_SHOPS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(String(shop).toLowerCase());
}

export async function getShopPlan(shop) {
  if (isComplimentary(shop)) return PLANS.INFERNO;
  try {
    const row = await prisma.shopPlan.findUnique({ where: { shop } });
    return PLANS[row?.plan] || PLANS.SPARK;
  } catch {
    return PLANS.SPARK;
  }
}

// `confirm` marks the plan as chosen by the merchant (a paid plan is active, or Spark was picked on purpose).
// Saving what Shopify says never un-chooses.
export async function setShopPlan(shop, planKey, subscriptionId = null, { confirm = Boolean(subscriptionId) } = {}) {
  const now = new Date();
  await prisma.shopPlan.upsert({
    where: { shop },
    create: { shop, plan: planKey, subscriptionId, planConfirmedAt: confirm ? now : null },
    update: confirm ? { plan: planKey, subscriptionId, planConfirmedAt: now } : { plan: planKey, subscriptionId },
  });
}

// Has this store been asked to choose a plan yet? If the table can't be read, the merchant is never blocked.
export async function planNeedsChoice(shop) {
  if (isComplimentary(shop)) return false;
  try {
    const row = await prisma.shopPlan.findUnique({ where: { shop } });
    return needsPlanChoice({ complimentary: false, row });
  } catch {
    return false;
  }
}

export function planKeyFromBillingName(name) {
  if (name === BILLING_NAMES.INFERNO) return "INFERNO";
  if (name === BILLING_NAMES.BLAZE) return "BLAZE";
  return "SPARK";
}

// Development stores get free test charges; real stores are billed for real.
export async function isDevelopmentStore(admin) {
  try {
    const response = await admin.graphql(`#graphql
      query StorePlan { shop { plan { partnerDevelopment } } }`);
    const json = await response.json();
    return Boolean(json?.data?.shop?.plan?.partnerDevelopment);
  } catch {
    return false;
  }
}

// Asks Shopify which plan is really active and saves it (Shopify is the source of truth).
export async function syncShopPlan({ billing, admin, shop }) {
  const isTest = await isDevelopmentStore(admin);
  if (isComplimentary(shop)) {
    return { plan: PLANS.INFERNO, isTest, subscription: null, complimentary: true };
  }
  const { appSubscriptions } = await billing.check({
    plans: [BILLING_NAMES.BLAZE, BILLING_NAMES.INFERNO],
    isTest,
  });
  const active = (appSubscriptions || []).find((s) => s.status === "ACTIVE") || null;
  const key = active ? planKeyFromBillingName(active.name) : "SPARK";
  await setShopPlan(shop, key, active?.id || null, { confirm: confirmOnSync(active) });
  return { plan: PLANS[key], isTest, subscription: active, complimentary: false };
}

export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function auctionsCreatedThisMonth(shop) {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM "Auction"
    WHERE "shop" = ${shop}
      AND "createdAt" >= ${monthStart()}
      AND "isTest" = false`;
  return Number(rows?.[0]?.n || 0);
}

export async function canCreateAuction(shop) {
  const plan = await getShopPlan(shop);
  const used = await auctionsCreatedThisMonth(shop);
  return {
    allowed: used < plan.monthlyLimit,
    used,
    limit: plan.monthlyLimit,
    plan,
  };
}
