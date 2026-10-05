// Buy It Now: the rules, kept apart from everything else so they can be tested.
//
// A merchant may give an auction a Buy It Now price. Shoppers can buy at that price until the first bid is placed
// (the eBay rule). A purchase is recorded as an instant winning bid at that price that ends the auction on the spot,
// so the normal winner invoice, emails and "pay all wins together" flow all work unchanged.

export const BUY_NOW_MESSAGES = {
  none: "This auction doesn't have a Buy It Now price.",
  gone: "Buy It Now is no longer available for this auction.",
  notStarted: "This auction has not started yet.",
  ended: "This auction has ended.",
};

// The price a merchant types in the form. Empty means "no Buy It Now". Anything else must make sense next to the
// starting bid and the reserve.
export function parseBuyNowPrice(value, { startingBid, reservePrice, max = 99999 } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return { ok: true, value: null };
  const price = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "Enter a valid Buy It Now price, or leave it empty." };
  if (price > max) return { ok: false, error: `The Buy It Now price can't be above $${max.toLocaleString("en-US")}.` };
  if (Number.isFinite(startingBid) && price <= startingBid) {
    return { ok: false, error: "The Buy It Now price must be higher than the starting bid. Leave it empty if you don't want one." };
  }
  if (reservePrice !== null && reservePrice !== undefined && Number.isFinite(reservePrice) && price < reservePrice) {
    return { ok: false, error: "The Buy It Now price must be at least the reserve price." };
  }
  return { ok: true, value: price };
}

// Can a shopper buy this auction right now, and at what price?
export function buyNowOffer({ buyNowPrice, reservePrice, startingBid, bidCount, startsAt, endsAt, now = new Date() }) {
  const price = Number(buyNowPrice);
  if (buyNowPrice === null || buyNowPrice === undefined || !Number.isFinite(price) || price <= 0) {
    return { available: false, reason: BUY_NOW_MESSAGES.none };
  }
  if (now < new Date(startsAt)) return { available: false, reason: BUY_NOW_MESSAGES.notStarted };
  if (now >= new Date(endsAt)) return { available: false, reason: BUY_NOW_MESSAGES.ended };
  if (Number(bidCount) > 0) return { available: false, reason: BUY_NOW_MESSAGES.gone };
  if (Number.isFinite(Number(startingBid)) && price <= Number(startingBid)) return { available: false, reason: BUY_NOW_MESSAGES.gone };
  if (reservePrice !== null && reservePrice !== undefined && price < Number(reservePrice)) return { available: false, reason: BUY_NOW_MESSAGES.gone };
  return { available: true, price: Math.round(price * 100) / 100 };
}
