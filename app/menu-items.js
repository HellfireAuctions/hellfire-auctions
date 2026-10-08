// Which links the store's main menu needs for the app: "Live Auctions" (the collection of running auctions) and
// "My Auctions" (each shopper's own page). Before, only My Auctions was ever added, so a new store had no menu link
// to the Live Auctions collection at all.
export const LIVE_PATH = "/collections/live-auctions";
export const LIVE_TITLE = "Live Auctions";
export const MY_AUCTIONS_PATH = "/apps/hellfire-auctions/my-auctions";

const walk = (items, test) => (Array.isArray(items) ? items : []).some((i) => test(i) || walk(i?.items, test));

export const isLiveAuctionsItem = (item) => String(item?.url || "").includes(LIVE_PATH) || String(item?.title || "").trim().toLowerCase() === LIVE_TITLE.toLowerCase();
export const isMyAuctionsItem = (item, myUrl = MY_AUCTIONS_PATH) => String(item?.url || "").includes(myUrl);

// What the menu already has (looks inside submenus too).
export function menuStatus(items, myUrl = MY_AUCTIONS_PATH) {
  return { hasLive: walk(items, isLiveAuctionsItem), hasMyAuctions: walk(items, (i) => isMyAuctionsItem(i, myUrl)) };
}

// The items to add. Live Auctions goes first. When we know the collection, the link points at the collection itself
// (so it survives a changed handle); otherwise it falls back to the standard address.
export function itemsToAdd({ hasLive, hasMyAuctions, collectionId, myAuctionsUrl = MY_AUCTIONS_PATH }) {
  const out = [];
  if (!hasLive) out.push(collectionId ? { title: LIVE_TITLE, type: "COLLECTION", resourceId: collectionId, items: [] } : { title: LIVE_TITLE, type: "HTTP", url: LIVE_PATH, items: [] });
  if (!hasMyAuctions) out.push({ title: "My Auctions", type: "HTTP", url: myAuctionsUrl, items: [] });
  return out;
}
