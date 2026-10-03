import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { getShopPlan, HOT_BID_THRESHOLD } from "../plans.server";
import { shopCurrency } from "../currency.server";

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
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");

  if (!shop) {
    return Response.json({ error: "Missing shop." }, { status: 400 });
  }

  const now = new Date();
  const auctions = await prisma.auction.findMany({
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
  });

  let handles = new Map();
  try {
    handles = await handlesFor(shop, auctions.map((a) => a.productId));
  } catch (error) {
    console.error("[auction-cards] handle lookup failed:", error?.message || error);
  }

  const plan = await getShopPlan(shop);

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
      isTest: Boolean(a.isTest),
      reserveMet: a.reservePrice == null ? null : Number(a.currentBid) >= Number(a.reservePrice),
    }));

  return Response.json(
    { now: now.toISOString(), currency: await shopCurrency(shop), branding: plan.branding, auctions: payload },
    { headers: { "Cache-Control": "no-store" } },
  );
};
