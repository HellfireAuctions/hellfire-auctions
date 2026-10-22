// "End now and sell": the merchant accepts the best offer early. The high bidder wins, a Shopify draft order is created and the
// invoice is emailed at once. Only a real (non-test) running auction with a bid at or above its reserve can be sold this way.
// This is also the quickest way for anyone (a new merchant, or an app reviewer) to see the whole flow: bid, sell, invoice.

export function sellNowDecision(auction, now = new Date()) {
  if (!auction) return { ok: false, message: "Auction could not be found." };
  if (["CANCELLED", "ENDED", "SETTLING"].includes(auction.status)) return { ok: false, message: "This auction has already ended." };
  if (auction.status !== "LIVE") return { ok: false, message: "Only a running auction can be sold early." };
  if (new Date(auction.endsAt).getTime() <= new Date(now).getTime()) return { ok: false, message: "This auction has already ended." };
  if (auction.isTest) return { ok: false, message: "Test auctions can't be sold: on a live store they never create an order or an invoice. Use a regular auction to see the winner's invoice." };
  if (!Number(auction.bidCount)) return { ok: false, message: "There are no bids yet, so there is nobody to sell to." };
  if (auction.reservePrice != null && Number(auction.currentBid) < Number(auction.reservePrice)) return { ok: false, message: "The reserve price hasn't been met yet, so it can't be sold." };
  return { ok: true };
}
