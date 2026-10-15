import prisma from "./db.server.js";
import { releaseStream } from "./stream-control.server.js";

// Live Drops and people's data. The privacy policy promises that a shopper's data can be shown and erased on request, that a
// store's data is erased after it uninstalls, and that old records are removed after 24 months. These do that for Live Drops
// (shows, items, claims and invoice records), the same as the auction versions do for auctions.

export const RETENTION_DAYS = 730;

// What we hold about one shopper, for Shopify's "customer data request".
export async function liveDropsDataFor({ shop, customerId, db = prisma }) {
  const claims = await db.actionClaim.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { quantity: true, createdAt: true, drop: { select: { title: true, price: true } } },
  });
  const buyers = await db.actionBuyer.findMany({ where: { shop, customerId }, select: { invoiceSentAt: true, paidAt: true, struckAt: true } });
  return {
    claims: claims.length,
    items: claims.map((c) => ({ title: c.drop?.title || "Item", quantity: c.quantity, price: c.drop?.price, at: c.createdAt })),
    invoices: buyers.filter((b) => b.invoiceSentAt).length,
    paid: buyers.filter((b) => b.paidAt).length,
    unpaidStrikes: buyers.filter((b) => b.struckAt).length,
  };
}

// Shopify's "customer erasure": this shopper's claims and invoice records, in this store only.
export async function eraseCustomerLiveDrops({ shop, customerId, db = prisma }) {
  const claims = await db.actionClaim.deleteMany({ where: { shop, customerId } });
  const buyers = await db.actionBuyer.deleteMany({ where: { shop, customerId } });
  return { claims: claims.count, buyers: buyers.count };
}

// The store uninstalled: stop what is running. A live show is stopped (so it cannot be claimed in or invoiced against a store the
// app can no longer reach), and every video channel is shut down.
export async function stopShopLiveDrops({ shop, db = prisma, release = releaseStream }) {
  const live = await db.actionSale.findMany({ where: { shop, status: "LIVE" }, select: { id: true } });
  for (const sale of live) {
    await db.actionDrop.updateMany({ where: { saleId: sale.id, status: "OPEN" }, data: { status: "CLOSED", closedAt: new Date() } });
    await db.actionSale.update({ where: { id: sale.id }, data: { status: "CANCELLED", streaming: false } });
  }
  const withVideo = await db.actionSale.findMany({ where: { shop, streamUid: { not: null } }, select: { id: true } });
  for (const sale of withVideo) {
    try {
      await release({ shop, saleId: sale.id, db });
    } catch (error) {
      console.error("[HELLFIRE LIVE DROPS] could not shut a video channel down:", sale.id, error?.message || error);
    }
  }
  return { stopped: live.length, channels: withVideo.length };
}

// Shopify's "shop erasure" (about 48 hours after uninstall): everything Live Drops holds for the store.
export async function eraseShopLiveDrops({ shop, db = prisma, release = releaseStream }) {
  const sales = await db.actionSale.findMany({ where: { shop }, select: { id: true, streamUid: true } });
  for (const sale of sales) {
    if (!sale.streamUid) continue;
    try {
      await release({ shop, saleId: sale.id, db });
    } catch (error) {
      console.error("[HELLFIRE LIVE DROPS] could not shut a video channel down:", sale.id, error?.message || error);
    }
  }
  await db.actionClaim.deleteMany({ where: { shop } });
  await db.actionBuyer.deleteMany({ where: { shop } });
  await db.actionDrop.deleteMany({ where: { shop } });
  await db.actionSale.deleteMany({ where: { shop } });
  return { shows: sales.length };
}

// Records are kept 24 months after a show ends, then deleted (the same rule as auctions).
export async function eraseOldLiveDrops({ db = prisma, now = Date.now() } = {}) {
  const cutoff = new Date(now - RETENTION_DAYS * 86_400_000);
  const old = await db.actionSale.findMany({
    where: { status: { in: ["ENDED", "CANCELLED"] }, OR: [{ endedAt: { lt: cutoff } }, { endedAt: null, updatedAt: { lt: cutoff } }] },
    select: { id: true },
    take: 500,
  });
  if (!old.length) return 0;
  const ids = old.map((s) => s.id);
  await db.actionBuyer.deleteMany({ where: { saleId: { in: ids } } });
  await db.actionClaim.deleteMany({ where: { saleId: { in: ids } } });
  await db.actionDrop.deleteMany({ where: { saleId: { in: ids } } });
  await db.actionSale.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}
