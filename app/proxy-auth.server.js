import { authenticate } from "./shopify.server";
import { validSignature, SHOP_PATTERN } from "./proxy-signature.js";

// Fast path for Shopify-signed app proxy requests (the bidding panel, product-card badges, My Auctions...).
//
// Shopify's own check does the same signature test, then also loads the store's login from the database and
// builds an admin client on EVERY request, which none of these routes use. At hundreds of refreshes a second
// that was the biggest cost left. Here the signature is checked in memory; anything unusual falls back to
// Shopify's full check, so this can only ever accept what Shopify's check accepts.
export async function proxyAuth(request) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (shop && SHOP_PATTERN.test(shop) && validSignature(url.search, process.env.SHOPIFY_API_SECRET)) {
    return { session: { shop } }; // the routes only read session.shop
  }
  return authenticate.public.appProxy(request);
}
