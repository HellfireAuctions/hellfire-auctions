import { unauthenticated } from "../shopify.server";
import { proxyAuth } from "../proxy-auth.server";
import prisma from "../db.server";
import { shopCurrency } from "../currency.server";
import { pathsFromNodes } from "../live-paths";
import { getShopSettings } from "../settings.server";

// Public (signed app-proxy) list of the store's running auctions, soonest-ending first.
// Only auctions whose product is published on the Online Store are returned.
const cache = new Map(); // "shop|limit" -> { at, body }
const CACHE_MS = 5000;

async function fetchNodes(admin, ids, withUrl) {
  const response = await admin.graphql(
    `#graphql
      query LiveBlockProducts($ids: [ID!]!) {
        nodes(ids: $ids) { ... on Product { id status handle ${withUrl ? "onlineStoreUrl" : ""} } }
      }`,
    { variables: { ids } },
  );
  return response.json();
}

// product id -> its page on the storefront. Problems are always logged (an empty list must never be a silent failure).
async function productPaths(shop, productIds) {
  if (!productIds.length) return new Map();
  try {
    const { admin } = await unauthenticated.admin(shop);
    let json = await fetchNodes(admin, productIds, true);
    if (json?.errors || !Array.isArray(json?.data?.nodes)) {
      console.error("[live-auctions] product lookup returned errors, retrying without the store address:", JSON.stringify(json?.errors || json).slice(0, 300));
      json = await fetchNodes(admin, productIds, false);
      if (json?.errors || !Array.isArray(json?.data?.nodes)) console.error("[live-auctions] product lookup failed:", JSON.stringify(json?.errors || json).slice(0, 300));
    }
    const paths = pathsFromNodes(json?.data?.nodes);
    if (!paths.size) console.error("[live-auctions] none of the", productIds.length, "running auctions has an active product page");
    return paths;
  } catch (error) {
    console.error("[live-auctions] product lookup failed:", error?.message || error);
    return new Map();
  }
}

export const loader = async ({ request }) => {
  const { session } = await proxyAuth(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  if (!shop) return Response.json({ error: "Missing shop" }, { status: 400 });
  const limit = Math.min(24, Math.max(1, Number(url.searchParams.get("limit")) || 8));

  const key = `${shop}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Response.json(hit.body);

  const now = new Date();
  const rows = await prisma.auction.findMany({
    where: { shop, startsAt: { lte: now }, endsAt: { gt: now }, status: { not: "CANCELLED" } },
    orderBy: { endsAt: "asc" },
    take: limit + 12, // a few spare, in case some products aren't published
    select: { id: true, productId: true, title: true, imageUrl: true, currentBid: true, startingBid: true, bidCount: true, endsAt: true, isTest: true },
  });
  const paths = await productPaths(shop, rows.map((r) => r.productId));
  const auctions = rows
    .filter((r) => paths.has(r.productId))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      title: r.title,
      image: r.imageUrl,
      url: paths.get(r.productId),
      currentBid: Number(r.currentBid || r.startingBid || 0),
      bidCount: r.bidCount || 0,
      endsAt: r.endsAt.toISOString(),
      isTest: Boolean(r.isTest),
    }));
  const settings = await getShopSettings(shop);
  const body = { now: now.toISOString(), currency: await shopCurrency(shop), auctions, hub: { enabled: settings.showLiveBubble !== false } };
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), body });
  return Response.json(body);
};
