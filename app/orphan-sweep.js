// Products the app created for auctions that no longer exist. They stay on the storefront as dead, badge-less items.
// A product is a leftover only if ALL of these hold: it is Active, its type and tags are the app's own, no auction
// (of any state) refers to it, and it is old enough that it can't be an auction still being created.
export const APP_TYPE = "Hellfire Auction";
export const MIN_AGE_MS = 30 * 60_000;

export function orphansToHide({ products, knownIds, now = new Date(), minAgeMs = MIN_AGE_MS }) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  const out = [];
  for (const p of Array.isArray(products) ? products : []) {
    if (!p || !p.id || p.status !== "ACTIVE" || p.productType !== APP_TYPE) continue;
    if (!(Array.isArray(p.tags) && p.tags.includes(APP_TYPE))) continue;
    if (known.has(p.id)) continue;
    const created = Date.parse(p.createdAt);
    if (!Number.isFinite(created) || now.getTime() - created < minAgeMs) continue;
    out.push(p.id);
  }
  return out;
}
