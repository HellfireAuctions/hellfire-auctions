import { orphansToHide } from "./orphan-sweep.js";
import { SELFTEST_SHOP } from "./self-test.server.js";

// Finds the app's own products that have no auction any more and takes them off the storefront (to Draft: never deleted,
// and a merchant can set them back to Active). Runs shortly after every start-up and then every 6 hours per store.
const EVERY_MS = 6 * 3_600_000;
const lastRun = () => (globalThis.__HF_ORPHAN_LAST__ ||= new Map());

export async function sweepShop(shop, { admin, db, now = new Date(), maxPages = 5 }) {
  const products = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await admin.graphql(
      `#graphql
        query HellfireProducts($cursor: String) {
          products(first: 100, after: $cursor, query: "product_type:'Hellfire Auction' AND status:active") {
            pageInfo { hasNextPage endCursor }
            nodes { id status createdAt tags productType }
          }
        }`,
      { variables: { cursor } },
    );
    const json = await res.json();
    if (json?.errors) throw new Error("product list: " + JSON.stringify(json.errors).slice(0, 200));
    const block = json?.data?.products;
    products.push(...(block?.nodes || []));
    if (!block?.pageInfo?.hasNextPage) break;
    cursor = block.pageInfo.endCursor;
  }
  if (!products.length) return { checked: 0, hidden: [] };

  const rows = await db.auction.findMany({ where: { shop, productId: { in: products.map((p) => p.id) } }, select: { productId: true } });
  const ids = orphansToHide({ products, knownIds: new Set(rows.map((r) => r.productId)), now });
  const hidden = [];
  for (const id of ids) {
    const res = await admin.graphql(
      `#graphql
        mutation HideLeftoverProduct($product: ProductUpdateInput!) {
          productUpdate(product: $product) { userErrors { message } }
        }`,
      { variables: { product: { id, status: "DRAFT" } } },
    );
    const errors = (await res.json())?.data?.productUpdate?.userErrors || [];
    if (errors.length) console.error("[hellfire-auctions] leftover product not hidden:", id, errors.map((e) => e.message).join(", "));
    else hidden.push(id);
  }
  return { checked: products.length, hidden };
}

export async function orphanSweepIfDue() {
  if (process.env.HELLFIRE_ORPHAN_SWEEP === "off" || process.uptime() < 120) return;
  const { default: prisma } = await import("./db.server.js");
  const { unauthenticated } = await import("./shopify.server.js");
  const sessions = await prisma.session.findMany({ where: { isOnline: false }, select: { shop: true }, distinct: ["shop"] });
  for (const { shop } of sessions) {
    if (shop === SELFTEST_SHOP || Date.now() - (lastRun().get(shop) || 0) < EVERY_MS) continue;
    lastRun().set(shop, Date.now());
    try {
      const { admin } = await unauthenticated.admin(shop);
      const result = await sweepShop(shop, { admin, db: prisma });
      if (result.hidden.length) console.log("[hellfire-auctions] leftover products taken off the storefront:", shop, JSON.stringify(result.hidden));
    } catch (error) {
      console.error("[hellfire-auctions] leftover-product sweep failed:", shop, error?.message || error);
    }
  }
}

// One run a couple of minutes after every start-up (the worker may sleep for up to 30 minutes between passes).
export function orphanSweepAfterBoot(delayMs = 150_000) {
  if (globalThis.__HF_ORPHAN_BOOT__) return;
  globalThis.__HF_ORPHAN_BOOT__ = true;
  const timer = setTimeout(() => orphanSweepIfDue().catch((error) => console.error("[hellfire-auctions] leftover-product sweep error:", error?.message || error)), delayMs);
  if (timer.unref) timer.unref();
}
