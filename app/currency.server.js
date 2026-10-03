import { unauthenticated } from "./shopify.server";

// The store's own currency (cached for an hour) and one money formatter for server-built text.
const cache = new Map();

export async function shopCurrency(shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.code;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(`#graphql
      query ShopCurrency { shop { currencyCode } }`);
    const code = (await response.json())?.data?.shop?.currencyCode || "USD";
    cache.set(shop, { at: Date.now(), code });
    return code;
  } catch {
    return hit?.code || "USD";
  }
}

export function formatMoney(value, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(Number(value || 0));
  } catch {
    return "$" + Number(value || 0).toFixed(2);
  }
}
