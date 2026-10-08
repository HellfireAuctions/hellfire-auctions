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
