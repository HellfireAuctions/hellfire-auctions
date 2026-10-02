// Pure bidding rules (no database, no network) so they can be tested on their own.
// Model: every bidder has ONE maximum bid. The system bids for them automatically
// (proxy bidding) like eBay: the leader pays one increment above the runner-up's
// maximum, never more than their own maximum.

export const MAX_ALLOWED_BID = 1_000_000;

const toCents = (value) => Math.round(Number(value) * 100) / 100;

export function bidIncrement(currentBid) {
  const bid = Number(currentBid || 0);
  if (bid < 25) return 1;
  if (bid < 100) return 2;
  return 5;
}

export function nextMinimumBid({ startingBid, currentBid, hasBids }) {
  return hasBids
    ? toCents(Number(currentBid || 0) + bidIncrement(currentBid))
    : toCents(startingBid);
}

function rank(bids) {
  return [...bids].sort(
    (a, b) =>
      Number(b.maxBid) - Number(a.maxBid) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * bids: [{ id, bidderId, maxBid, createdAt }]
 * Returns { leaderId, leaderMax, price, reserveMet, amounts: { [bidId]: amount } }
 */
export function resolveProxyBids({
  startingBid,
  currentBid = 0,
  reservePrice = null,
  bids,
}) {
  const ranked = rank(bids);
  const leader = ranked[0] || null;

  if (!leader) {
    return {
      leaderId: null,
      leaderMax: 0,
      price: 0,
      reserveMet: reservePrice == null ? null : false,
      amounts: {},
    };
  }

  const leaderMax = Number(leader.maxBid);
  const runnerUp = ranked[1] || null;

  let price;
  if (!runnerUp) {
    price = Number(startingBid);
  } else {
    const runnerMax = Number(runnerUp.maxBid);
    price =
      runnerMax >= leaderMax
        ? leaderMax // exact tie: the earlier bid wins and pays its full maximum
        : Math.min(leaderMax, runnerMax + bidIncrement(runnerMax));
  }

  price = Math.max(price, Number(startingBid), Number(currentBid || 0));

  // eBay-style reserve: once the leader's maximum reaches the reserve, price jumps to it.
  if (reservePrice != null && leaderMax >= Number(reservePrice) && price < Number(reservePrice)) {
    price = Number(reservePrice);
  }

  price = toCents(Math.min(price, leaderMax));

  const amounts = {};
  for (const bid of ranked) {
    amounts[bid.id] =
      bid.id === leader.id ? price : toCents(Math.min(Number(bid.maxBid), price));
  }

  return {
    leaderId: leader.bidderId,
    leaderMax,
    price,
    reserveMet: reservePrice == null ? null : price >= Number(reservePrice),
    amounts,
  };
}
