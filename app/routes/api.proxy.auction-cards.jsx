import { unauthenticated } from "../shopify.server";
import { proxyAuth } from "../proxy-auth.server";
import prisma from "../db.server";
import { memo } from "../memo.server";
import { getShopPlan, HOT_BID_THRESHOLD } from "../plans.server";
import { shopCurrency } from "../currency.server";
import { olderEndedEntry, OLDER_ENDED_DAYS, OLDER_ENDED_MAX } from "../cards-older";

// Read-only data for the product-card badges: one request per page returns every
// auction the storefront might show, keyed by product handle (themes link cards by handle).
const HANDLE_CACHE_MS = 5 * 60_000;
const ENDED_WINDOW_MS = 3 * 24 * 60 * 60_000; // keep showing "Auction ended" for 3 days
const handleCache = new Map(); // shop -> { at, map: Map(productGid -> handle) }

function auctionState(auction, now) {
  if (now < auction.startsAt) return "UPCOMING";
  if (now >= auction.endsAt) return "ENDED";
  return "LIVE";
}

async function handlesFor(shop, productIds) {
  const cached = handleCache.get(shop);
  const fresh = cached && Date.now() - cached.at < HANDLE_CACHE_MS;
  const map = fresh ? cached.map : new Map();
  const missing = [...new Set(productIds)].filter((id) => !map.has(id));

  if (missing.length) {
    const { admin } = await unauthenticated.admin(shop);
    for (let i = 0; i < missing.length; i += 100) {
      const response = await admin.graphql(
        `#graphql
          query AuctionCardHandles($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product { id handle }
            }
          }
        `,
        { variables: { ids: missing.slice(i, i + 100) } },
      );
      const json = await response.json();
      for (const node of json?.data?.nodes || []) {
        if (node?.id && node?.handle) map.set(node.id, node.handle);
      }
    }
  }

  handleCache.set(shop, { at: fresh ? cached.at : Date.now(), map });
  return map;
}

export const loader = async ({ request }) => {
  const { session } = await proxyAuth(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");

  if (!shop) {
    return Response.json({ error: "Missing shop." }, { status: 400 });
  }

  const now = new Date();
  // The list of auctions is the same for every shopper, so concurrent requests share one fetch for 2 seconds.
  const auctions = await memo("cards:" + shop, 2000, () => prisma.auction.findMany({
    where: { shop, endsAt: { gt: new Date(now.getTime() - ENDED_WINDOW_MS) } },
    select: {
      id: true,
      productId: true,
      startingBid: true,
      currentBid: true,
      reservePrice: true,
      isTest: true,
      bidCount: true,
      startsAt: true,
      endsAt: true,
    },
    orderBy: { createdAt: "asc" }, // newest auction per product wins
    take: 250,
  }));

  // Auctions that ended more than 3 days ago keep their card hidden too (only "this one has ended" is sent for them).
  const older = await memo("cards-old:" + shop, 60_000, () => prisma.auction.findMany({
    where: { shop, endsAt: { gt: new Date(now.getTime() - OLDER_ENDED_DAYS * 24 * 60 * 60_000), lte: new Date(now.getTime() - ENDED_WINDOW_MS) } },
    select: { productId: true, startsAt: true, endsAt: true },
    orderBy: { endsAt: "desc" },
    take: OLDER_ENDED_MAX,
  }));

  let handles = new Map();
  try {
    handles = await handlesFor(shop, [...auctions, ...older].map((a) => a.productId));
  } catch (error) {
    console.error("[auction-cards] handle lookup failed:", error?.message || error);
  }

  const plan = await memo("plan:" + shop, 15_000, () => getShopPlan(shop));

  // Social proof: how many people are watching / bidding (counts only, never who).
  const watcherCounts = new Map();
  const bidderCounts = new Map();
  if (auctions.length) {
    try {
      const ids = auctions.map((a) => a.id);
      for (const r of await memo("cards-watch:" + shop, 2000, () => prisma.watch.groupBy({ by: ["auctionId"], where: { auctionId: { in: ids } }, _count: { _all: true } }))) watcherCounts.set(r.auctionId, r._count._all);
      for (const r of await memo("cards-bidders:" + shop, 2000, () => prisma.bid.groupBy({ by: ["auctionId"], where: { auctionId: { in: ids } }, _count: { _all: true } }))) bidderCounts.set(r.auctionId, r._count._all);
    } catch (error) {
      console.error("[auction-cards] social counts failed:", error?.message || error);
    }
  }

  const customerId = url.searchParams.get("logged_in_customer_id");
  const myStatus = new Map();
  if (customerId && auctions.length) {
    const bids = await prisma.bid.findMany({
      where: { auctionId: { in: auctions.map((a) => a.id) } },
      orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
      select: { auctionId: true, bidderId: true },
    });
    const leader = new Map();
    const mine = new Set();
    for (const b of bids) {
      if (!leader.has(b.auctionId)) leader.set(b.auctionId, b.bidderId);
      if (b.bidderId === customerId) mine.add(b.auctionId);
    }
    for (const id of mine) myStatus.set(id, leader.get(id) === customerId ? "WINNING" : "OUTBID");
  }

  const payload = auctions
    .filter((a) => handles.has(a.productId))
    .map((a) => ({
      handle: handles.get(a.productId),
      hasBids: a.bidCount > 0,
      amount: Number(a.bidCount > 0 ? a.currentBid : a.startingBid),
      bidCount: a.bidCount,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      status: auctionState(a, now),
      hot: plan.hotBadge && a.bidCount >= HOT_BID_THRESHOLD,
      myStatus: myStatus.get(a.id) || null,
      hasReserve: a.reservePrice != null,
      watchers: watcherCounts.get(a.id) || 0,
      bidders: bidderCounts.get(a.id) || 0,
      isTest: Boolean(a.isTest),
      reserveMet: a.reservePrice == null ? null : Number(a.currentBid) >= Number(a.reservePrice),
    }));

  // Older ones come first, so a product that was relisted (a newer auction) is still treated by its newest auction.
  const olderPayload = older.filter((a) => handles.has(a.productId)).map((a) => olderEndedEntry(handles.get(a.productId), a));

  return Response.json(
    { now: now.toISOString(), currency: await shopCurrency(shop), branding: plan.branding, auctions: [...olderPayload, ...payload] },
    { headers: { "Cache-Control": "no-store" } },
  );
};
