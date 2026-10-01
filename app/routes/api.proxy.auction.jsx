import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function normalizeProductId(value) {
  if (!value) return null;

  return value.startsWith("gid://")
    ? value
    : `gid://shopify/Product/${value}`;
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
  const { session } =
    await authenticate.public.appProxy(request);

  const url = new URL(request.url);

  const shop =
    session?.shop ||
    url.searchParams.get("shop");

  const productId =
    normalizeProductId(
      url.searchParams.get("product_id"),
    );

  if (!shop || !productId) {
    return Response.json(
      {
        error: "Missing shop or product.",
      },
      { status: 400 },
    );
  }

  const auction =
    await prisma.auction.findFirst({
      where: {
        shop,
        productId,
      },
      include: {
        bids: {
          orderBy: {
            maxBid: "desc",
          },
          take: 10,
          select: {
            amount: true,
            maxBid: true,
            bidderId: true,
            createdAt: true,
          },
        },
      },
    });

  const publicBids = auction?.bids || [];
  const highestBid = publicBids.reduce(
    (highest, bid) =>
      Number(bid.maxBid || bid.amount) > Number(highest?.maxBid || highest?.amount || 0)
        ? bid
        : highest,
    null,
  );

  return Response.json({
    loggedInCustomerId:
      url.searchParams.get(
        "logged_in_customer_id",
      ) || null,

    auction: auction
      ? {
          id: auction.id,
          title: auction.title,
          startingBid: auction.startingBid,
          currentBid: auction.currentBid,
          highestBidder: highestBid ? maskedBidder(highestBid.bidderId) : null,
          reservePrice: auction.reservePrice,
          startsAt: auction.startsAt,
          endsAt: auction.endsAt,
          status: auctionState(auction),
          bids: publicBids.map(({ amount, createdAt }) => ({ amount, createdAt })),
        }
      : null,
  });
};

function bidIncrement() {
  return 1;
}

export const action = async ({ request }) => {
  const { session } =
    await authenticate.public.appProxy(request);

  const url = new URL(request.url);

  const shop =
    session?.shop ||
    url.searchParams.get("shop");

  const customerId =
    url.searchParams.get(
      "logged_in_customer_id",
    );

  if (!customerId) {
    return Response.json(
      {
        error: "Please sign in to place a bid.",
      },
      { status: 401 },
    );
  }

  const formData =
    await request.formData();

  const productId =
    normalizeProductId(
      formData.get("product_id")?.toString() ||
      url.searchParams.get("product_id"),
    );

  const amount =
    Number(formData.get("amount"));

  if (
    !shop ||
    !productId ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return Response.json(
      {
        error: "Enter a valid bid.",
      },
      { status: 400 },
    );
  }

  const auction =
    await prisma.auction.findFirst({
      where: {
        shop,
        productId,
      },
    });

  if (!auction) {
    return Response.json(
      {
        error: "Auction not found.",
      },
      { status: 404 },
    );
  }

  const now = new Date();

  if (now < auction.startsAt) {
    return Response.json(
      {
        error: "This auction has not started yet.",
      },
      { status: 400 },
    );
  }

  if (now >= auction.endsAt) {
    return Response.json(
      {
        error: "This auction has ended.",
      },
      { status: 400 },
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.auction.findUnique({ where: { id: auction.id } });
    if (!current) return { error: "Auction not found." };

    const increment = bidIncrement();
    const preBids = await tx.bid.findMany({
      where: { auctionId: current.id },
      orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
    });
    const existing = preBids.find((bid) => bid.bidderId === customerId) || null;
    const oldMax = existing ? Number(existing.maxBid || existing.amount) : 0;
    const wasHighest = Boolean(existing && preBids[0]?.id === existing.id);
    const currentBid = Number(current.currentBid || 0);
    const minimumBid = preBids.length > 0
      ? currentBid + increment
      : Number(current.startingBid);

    if (existing && amount <= oldMax) {
      return { error: "Your maximum bid is already at or above that amount." };
    }
    if (!existing && amount < minimumBid) {
      return { error: "Your maximum bid must be at least the minimum bid." };
    }

    if (existing) {
      await tx.bid.update({
        where: { id: existing.id },
        data: { maxBid: amount },
      });
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

    const bids = await tx.bid.findMany({
      where: { auctionId: current.id },
      orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
    });

    const highest = bids[0];
    const secondHighest = bids[1];
    const highestMax = Number(highest.maxBid || highest.amount);
    const secondMax = secondHighest ? Number(secondHighest.maxBid || secondHighest.amount) : 0;
    const highestChanged = !wasHighest && highest.bidderId === customerId;
    const displayedBid = preBids.length === 0
      ? Number(current.startingBid)
      : highestChanged
      ? Math.min(
          highestMax,
          Math.max(
            Number(current.startingBid),
            Number(current.currentBid || 0) + increment,
            secondMax + increment,
          ),
        )
      : Number(current.currentBid || 0);

    for (const bid of bids) {
      const bidAmount = bid.id === highest.id
        ? displayedBid
        : Math.min(Number(bid.maxBid || bid.amount), displayedBid);
      if (Number(bid.amount) !== bidAmount) {
        await tx.bid.update({ where: { id: bid.id }, data: { amount: bidAmount } });
      }
    }

    await tx.auction.update({
      where: { id: current.id },
      data: { currentBid: displayedBid },
    });

    return { success: true, currentBid: displayedBid, maximumBid: amount };
  });

  if (result.error) {
    return Response.json(
      result,
      { status: 409 },
    );
  }

  return Response.json(result);
};
