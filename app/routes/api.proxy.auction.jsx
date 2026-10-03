import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { notifyOutbid } from "../notifications.server";
import {
  MAX_ALLOWED_BID,
  bidIncrement,
  nextMinimumBid,
  resolveProxyBids,
} from "../bidding.server";

// Shared 1-second cache: 100 viewers refreshing every 2s cost about the same as one.
const auctionCache = new Map(); // "shop|productId" -> { at, auction }
const CACHE_MS = 1000;
async function getAuctionCached(shop, productId) {
  const key = shop + "|" + productId;
  const hit = auctionCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.auction;
  const auction = await getAuctionCached(shop, productId);
  if (auctionCache.size > 2000) auctionCache.clear();
  auctionCache.set(key, { at: Date.now(), auction });
  return auction;
}

// Bid spam protection: one bid per customer per second.
const lastBidAt = new Map();
const BID_COOLDOWN_MS = 1000;

function normalizeProductId(value) {
  if (!value) return null;
  return value.startsWith("gid://") ? value : `gid://shopify/Product/${value}`;
}

function auctionState(auction) {
  const now = new Date();
  if (now < auction.startsAt) return "UPCOMING";
  if (now >= auction.endsAt) return "ENDED";
  return "LIVE";
}

function maskedBidder(customerId) {
  const value = String(customerId || "");
  if (!value) return "Bidder";
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return "Bidder #" + String(hash % 10000).padStart(4, "0");
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const productId = normalizeProductId(url.searchParams.get("product_id"));

  if (!shop || !productId) {
    return Response.json({ error: "Missing shop or product." }, { status: 400 });
  }

  const auction = await prisma.auction.findFirst({
    where: { shop, productId },
    orderBy: { createdAt: "desc" },
    include: {
      bids: {
        orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
        take: 10,
        select: { amount: true, maxBid: true, bidderId: true, createdAt: true },
      },
    },
  });

  const publicBids = auction?.bids || [];
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || null;
  const myBid =
    loggedInCustomerId && auction
      ? await prisma.bid.findFirst({
          where: { auctionId: auction.id, bidderId: loggedInCustomerId },
          select: { maxBid: true },
        })
      : null;
  const highestBid = publicBids[0] || null;
  let myStatus = null;
  if (auction && myBid && loggedInCustomerId) {
    const iLead = highestBid?.bidderId === loggedInCustomerId;
    const ended = new Date() >= auction.endsAt;
    const reserveOk = auction.reservePrice == null || Number(auction.currentBid) >= Number(auction.reservePrice);
    myStatus = ended ? (iLead ? (reserveOk ? "WON" : "RESERVE_NOT_MET") : "LOST") : iLead ? "WINNING" : "OUTBID";
  }
  const hasReserve = auction?.reservePrice != null;


  return Response.json({
    loggedInCustomerId,
    auction: auction
      ? {
          id: auction.id,
          title: auction.title,
          startingBid: auction.startingBid,
          currentBid: auction.currentBid,
          bidCount: auction.bidCount,
          minimumBid: nextMinimumBid({
            startingBid: auction.startingBid,
            currentBid: auction.currentBid,
            hasBids: publicBids.length > 0,
          }),
          myMaximumBid: myBid ? Number(myBid.maxBid) : null,
          myStatus,
          highestBidder: highestBid ? maskedBidder(highestBid.bidderId) : null,
          // The reserve amount itself is never sent to the storefront.
          hasReserve,
          reserveMet: hasReserve
            ? Number(auction.currentBid || 0) >= Number(auction.reservePrice)
            : null,
          startsAt: auction.startsAt,
          endsAt: auction.endsAt,
          status: auctionState(auction),
          bids: publicBids.map(({ amount, createdAt }) => ({ amount, createdAt })),
        }
      : null,
  });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!customerId) {
    return Response.json({ error: "Please sign in to place a bid." }, { status: 401 });
  }

  const lastAt = lastBidAt.get(customerId) || 0;
  if (Date.now() - lastAt < BID_COOLDOWN_MS) {
    return Response.json({ error: "You're bidding too fast. Please wait a second and try again." }, { status: 429 });
  }
  if (lastBidAt.size > 10000) lastBidAt.clear();
  lastBidAt.set(customerId, Date.now());

  const formData = await request.formData();
  const productId = normalizeProductId(
    formData.get("product_id")?.toString() || url.searchParams.get("product_id"),
  );
  const amount = Math.round(Number(formData.get("amount")) * 100) / 100;

  if (!shop || !productId || !Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: "Enter a valid bid." }, { status: 400 });
  }
  if (amount > MAX_ALLOWED_BID) {
    return Response.json({ error: "That bid is above the allowed maximum." }, { status: 400 });
  }

  const auction = await prisma.auction.findFirst({ where: { shop, productId }, orderBy: { createdAt: "desc" } });
  if (!auction) {
    return Response.json({ error: "Auction not found." }, { status: 404 });
  }

  const now = new Date();
  if (now < auction.startsAt) {
    return Response.json({ error: "This auction has not started yet." }, { status: 400 });
  }
  if (now >= auction.endsAt) {
    return Response.json({ error: "This auction has ended." }, { status: 400 });
  }

  const result = await prisma.$transaction(
    async (tx) => {
      // One bid at a time per auction: lock the row, then re-check everything.
      await tx.$queryRaw`SELECT "id" FROM "Auction" WHERE "id" = ${auction.id} FOR UPDATE`;

      const current = await tx.auction.findUnique({ where: { id: auction.id } });
      if (!current) return { error: "Auction not found." };

      const transactionNow = new Date();
      if (transactionNow < current.startsAt) return { error: "This auction has not started yet." };
      if (transactionNow >= current.endsAt) return { error: "This auction has ended." };

      const preBids = await tx.bid.findMany({ where: { auctionId: current.id } });
      const minimumBid = nextMinimumBid({
        startingBid: current.startingBid,
        currentBid: current.currentBid,
        hasBids: preBids.length > 0,
      });
      const existing = preBids.find((bid) => bid.bidderId === customerId) || null;
      const oldMax = existing ? Number(existing.maxBid || existing.amount) : 0;

      if (amount < minimumBid) {
        return { error: "Your maximum bid must be at least the minimum bid." };
      }
      if (existing && amount <= oldMax) {
        return { error: "Your maximum bid is already at or above that amount." };
      }

      if (existing) {
        await tx.bid.update({ where: { id: existing.id }, data: { maxBid: amount } });
      } else {
        await tx.bid.create({
          data: {
            auctionId: current.id,
            bidderId: customerId,
            bidderEmail: null,
            amount: minimumBid,
            maxBid: amount,
          },
        });
      }

      const bids = await tx.bid.findMany({ where: { auctionId: current.id } });
      const outcome = resolveProxyBids({
        startingBid: current.startingBid,
        currentBid: current.currentBid,
        reservePrice: current.reservePrice,
        bids,
      });

      for (const bid of bids) {
        const newAmount = outcome.amounts[bid.id];
        if (Number(bid.amount) !== newAmount) {
          await tx.bid.update({ where: { id: bid.id }, data: { amount: newAmount } });
        }
      }

      const updated = await tx.auction.update({
        where: { id: current.id },
        data: { currentBid: outcome.price, bidCount: { increment: 1 } },
      });

      return {
        success: true,
        currentBid: outcome.price,
        maximumBid: amount,
        isHighBidder: outcome.leaderId === customerId,
        nextIncrement: bidIncrement(outcome.price),
        bidCount: updated.bidCount,
        leaderChanged: preBids.length > 0 && outcome.leaderId !== (preBids.slice().sort((a, b) => Number(b.maxBid) - Number(a.maxBid) || new Date(a.createdAt) - new Date(b.createdAt))[0]?.bidderId),
        previousLeaderId: preBids.slice().sort((a, b) => Number(b.maxBid) - Number(a.maxBid) || new Date(a.createdAt) - new Date(b.createdAt))[0]?.bidderId || null,
      };
    },
    { timeout: 10000 },
  );

  console.log(
    "[HELLFIRE BID]",
    JSON.stringify({
      auctionId: auction.id,
      productId,
      customerId,
      maxBidEntered: amount,
      accepted: !result.error,
      reason: result.error || null,
      currentBid: result.currentBid ?? null,
      bidCount: result.bidCount ?? null,
      isHighBidder: result.isHighBidder ?? null,
      leaderChanged: result.leaderChanged ?? null,
    }),
  );

  if (result.error) {
    return Response.json(result, { status: 409 });
  }

  // New bid: everyone sees it on their very next refresh.
  auctionCache.delete(shop + "|" + productId);

  // Outbid notice for whoever just lost the lead (runs after the bid is saved; never blocks it).
  if (result.leaderChanged && result.previousLeaderId && result.previousLeaderId !== customerId) {
    notifyOutbid({
      shop,
      auction,
      outbidCustomerId: result.previousLeaderId,
      currentBid: result.currentBid,
    });
  }

  const { previousLeaderId: _hidden, ...publicResult } = result;
  return Response.json(publicResult);
};
