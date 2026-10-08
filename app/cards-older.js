// Auctions that ended a while ago keep their card hidden on the storefront. The storefront only needs to know "this product's
// auction has ended", so older ones are sent as the bare minimum, in exactly the shape the card script already understands.
export const OLDER_ENDED_DAYS = 90;
export const OLDER_ENDED_MAX = 150;

export function olderEndedEntry(handle, auction) {
  return {
    handle,
    hasBids: false,
    amount: 0,
    bidCount: 0,
    startsAt: auction.startsAt,
    endsAt: auction.endsAt,
    status: "ENDED",
    hot: false,
    myStatus: null,
    hasReserve: false,
    watchers: 0,
    bidders: 0,
    isTest: false,
    reserveMet: null,
  };
}

// Which auctions the badge list is built from. Running and upcoming auctions always come first in importance (they are
// never crowded out by a burst of finished ones); recently ended ones follow. Both inputs arrive newest-first from the
// database; the result is oldest-first with ended before active, so for a relisted product its newest auction is last
// and wins (the storefront script lets a later entry for the same product replace an earlier one).
export function orderForCards(active, endedRecent) {
  const list = (x) => (Array.isArray(x) ? [...x] : []);
  return [...list(endedRecent).reverse(), ...list(active).reverse()];
}
