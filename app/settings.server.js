import prisma from "./db.server.js";
import { BIDDER_RULE_VALUES, DEFAULT_APPROVED_TAG, cleanTag } from "./bidder-rules.js";

// Per-store choices: unpaid winners and the default shipping weight. If the table can't be read, safe defaults apply.
export const SETTING_DEFAULTS = { autoOfferNext: true, strikeLimit: 2, defaultWeight: null, defaultWeightUnit: "OUNCES", bidderRule: "ANYONE", approvedTag: DEFAULT_APPROVED_TAG };
export const STRIKE_LIMIT_CHOICES = [0, 1, 2, 3, 5]; // 0 = never block automatically
export const WEIGHT_UNITS = ["OUNCES", "POUNDS", "GRAMS", "KILOGRAMS"];

export async function getShopSettings(shop) {
  try {
    const row = await prisma.shopSettings.findUnique({ where: { shop } });
    return {
      autoOfferNext: row?.autoOfferNext ?? SETTING_DEFAULTS.autoOfferNext,
      strikeLimit: row?.strikeLimit ?? SETTING_DEFAULTS.strikeLimit,
      defaultWeight: row?.defaultWeight > 0 ? Number(row.defaultWeight) : null,
      defaultWeightUnit: WEIGHT_UNITS.includes(row?.defaultWeightUnit) ? row.defaultWeightUnit : SETTING_DEFAULTS.defaultWeightUnit,
      bidderRule: BIDDER_RULE_VALUES.includes(row?.bidderRule) ? row.bidderRule : SETTING_DEFAULTS.bidderRule,
      approvedTag: cleanTag(row?.approvedTag) || SETTING_DEFAULTS.approvedTag,
    };
  } catch (error) {
    console.error("[settings] could not read settings, using defaults:", error?.message || error);
    return { ...SETTING_DEFAULTS };
  }
}

// Saves only what is passed; everything else keeps its current value.
export async function saveShopSettings(shop, changes) {
  const current = await getShopSettings(shop);
  const next = { ...current };
  if ("autoOfferNext" in changes) next.autoOfferNext = Boolean(changes.autoOfferNext);
  if ("strikeLimit" in changes) next.strikeLimit = STRIKE_LIMIT_CHOICES.includes(Number(changes.strikeLimit)) ? Number(changes.strikeLimit) : SETTING_DEFAULTS.strikeLimit;
  if ("defaultWeight" in changes) {
    const w = Number(changes.defaultWeight);
    next.defaultWeight = Number.isFinite(w) && w > 0 && w <= 100000 ? Math.round(w * 100) / 100 : null;
  }
  if ("defaultWeightUnit" in changes) next.defaultWeightUnit = WEIGHT_UNITS.includes(changes.defaultWeightUnit) ? changes.defaultWeightUnit : SETTING_DEFAULTS.defaultWeightUnit;
  if ("bidderRule" in changes) next.bidderRule = BIDDER_RULE_VALUES.includes(changes.bidderRule) ? changes.bidderRule : SETTING_DEFAULTS.bidderRule;
  if ("approvedTag" in changes) next.approvedTag = cleanTag(changes.approvedTag) || SETTING_DEFAULTS.approvedTag;
  await prisma.shopSettings.upsert({ where: { shop }, create: { shop, ...next }, update: next });
  return next;
}

// A bidder reaching the limit is blocked. 0 means never.
export function reachedLimit(strikes, limit) {
  return Number(limit) > 0 && Number(strikes) >= Number(limit);
}

// One unpaid sale per invoice (a combined invoice of several items is still one non-payment).
// The marker is a bookkeeping row, erased with the customer's data.
export async function recordStrike(shop, auction, customerId, draftId) {
  const id = String(customerId);
  const key = String(draftId || auction.id);
  let added = false;
  const existing = await prisma.$queryRaw`
    SELECT 1 AS x FROM "AuctionNotification" n JOIN "Auction" a ON a."id" = n."auctionId"
    WHERE a."shop" = ${shop} AND n."type" = 'STRIKE' AND n."customerId" = ${id} AND n."key" = ${key} LIMIT 1`;
  if (!existing.length) {
    try {
      await prisma.auctionNotification.create({ data: { auctionId: auction.id, customerId: id, type: "STRIKE", key } });
      added = true;
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
  }
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM "AuctionNotification" n JOIN "Auction" a ON a."id" = n."auctionId"
    WHERE a."shop" = ${shop} AND n."type" = 'STRIKE' AND n."customerId" = ${id}`;
  const strikes = Number(rows?.[0]?.n || 0);
  const { strikeLimit } = await getShopSettings(shop);
  let blocked = Boolean(await prisma.blockedBidder.findUnique({ where: { shop_customerId: { shop, customerId: id } } }));
  if (!blocked && reachedLimit(strikes, strikeLimit)) {
    await prisma.blockedBidder.upsert({ where: { shop_customerId: { shop, customerId: id } }, create: { shop, customerId: id }, update: {} });
    blocked = true;
  }
  return { strikes, blocked, added };
}
