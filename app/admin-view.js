// Rules for the app's admin pages. The page's data loading and actions are shared; each address shows its own sections.
export const VIEWS = { HOME: "home", ADD: "add", AUCTIONS: "auctions", SETTINGS: "settings" };

// Which page is this? (/app = the setup guide; the others have their own address)
export function viewFromPath(pathname) {
  const p = String(pathname || "").split("?")[0].replace(/\/+$/, "");
  if (p.endsWith("/app/add-auction")) return VIEWS.ADD;
  if (p.endsWith("/app/auctions")) return VIEWS.AUCTIONS;
  if (p.endsWith("/app/settings")) return VIEWS.SETTINGS;
  return VIEWS.HOME;
}

// The same time-based rule the auction cards have always used.
export function auctionState(auction, now = Date.now()) {
  if (now < new Date(auction.startsAt).getTime()) return "UPCOMING";
  if (now >= new Date(auction.endsAt).getTime()) return "ENDED";
  return "LIVE";
}

export function countByState(auctions, now = Date.now()) {
  const counts = { LIVE: 0, UPCOMING: 0, ENDED: 0, ALL: 0 };
  for (const a of Array.isArray(auctions) ? auctions : []) {
    counts[auctionState(a, now)] += 1;
    counts.ALL += 1;
  }
  return counts;
}

export function filterAuctions(auctions, filter, now = Date.now()) {
  const list = Array.isArray(auctions) ? auctions : [];
  return !filter || filter === "ALL" ? list : list.filter((a) => auctionState(a, now) === filter);
}

export const FILTER_LABELS = { LIVE: "Running", UPCOMING: "Upcoming", ENDED: "Ended", ALL: "All" };
