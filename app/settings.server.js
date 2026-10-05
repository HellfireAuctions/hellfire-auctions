import prisma from "./db.server.js";

// Per-store choices about unpaid winners. If the table can't be read, the safe defaults apply.
export const SETTING_DEFAULTS = { autoOfferNext: true, strikeLimit: 2 };
export const STRIKE_LIMIT_CHOICES = [0, 1, 2, 3, 5]; // 0 = never block automatically

export async function getShopSettings(shop) {
  try {
    const row = await prisma.shopSettings.findUnique({ where: { shop } });
    return {
      autoOfferNext: row?.autoOfferNext ?? SETTING_DEFAULTS.autoOfferNext,
      strikeLimit: row?.strikeLimit ?? SETTING_DEFAULTS.strikeLimit,
    };
  } catch (error) {
    console.error("[settings] could not read settings, using defaults:", error?.message || error);
    return { ...SETTING_DEFAULTS };
  }
}

export async function saveShopSettings(shop, { autoOfferNext, strikeLimit }) {
  const data = {
    autoOfferNext: Boolean(autoOfferNext),
    strikeLimit: STRIKE_LIMIT_CHOICES.includes(Number(strikeLimit)) ? Number(strikeLimit) : SETTING_DEFAULTS.strikeLimit,
  };
  await prisma.shopSettings.upsert({ where: { shop }, create: { shop, ...data }, update: data });
  return data;
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
