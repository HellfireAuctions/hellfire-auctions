// "End now and sell": the merchant accepts the best offer early. The high bidder wins, a Shopify draft order is created and the
// invoice is emailed at once. A running auction can be sold this way, and so can one that was ended early with "End now" (so a
// merchant who pressed the wrong button is never stuck). Only a real (non-test) auction with a bid at or above its reserve qualifies.
// This is also the quickest way for anyone (a new merchant, or an app reviewer) to see the whole flow: bid, sell, invoice.

export function sellNowDecision(auction, now = new Date()) {
  if (!auction) return { ok: false, message: "Auction could not be found." };
  if (["ENDED", "SETTLING"].includes(auction.status)) return { ok: false, message: "This auction has already ended." };
  const endedEarly = auction.status === "CANCELLED";
  if (!endedEarly && auction.status !== "LIVE") return { ok: false, message: "Only a running auction can be sold early." };
  if (!endedEarly && new Date(auction.endsAt).getTime() <= new Date(now).getTime()) return { ok: false, message: "This auction has already ended." };
  if (endedEarly && auction.winnerId) return { ok: false, message: "This auction already has a winner." };
  if (auction.isTest) return { ok: false, message: "Test auctions can't be sold: on a live store they never email or charge anyone. Use a regular auction to see the winner's invoice." };
  if (!Number(auction.bidCount)) return { ok: false, message: "There are no bids yet, so there is nobody to sell to." };
  if (auction.reservePrice != null && Number(auction.currentBid) < Number(auction.reservePrice)) return { ok: false, message: "The reserve price hasn't been met yet, so it can't be sold." };
  return { ok: true };
}
