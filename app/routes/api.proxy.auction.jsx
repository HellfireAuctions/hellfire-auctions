import { authenticate, apiVersion, sessionStorage } from "../shopify.server";
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

async function recoverMissingAuction(shop, productId) {
  const sessions = await sessionStorage.findSessionsByShop(shop);
  const offlineSession = sessions.find((item) => !item.isOnline && item.accessToken);

  if (!offlineSession?.accessToken) return null;

  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": offlineSession.accessToken,
    },
    body: JSON.stringify({
      query: `query RecoverAuctionProduct($id: ID!) {
        product(id: $id) {
          id
          title
          descriptionHtml
          tags
          featuredImage { url }
          variants(first: 1) { nodes { price } }
        }
      }`,
      variables: { id: productId },
    }),
  });

  if (!response.ok) return null;

  const json = await response.json();
  const product = json?.data?.product;
  if (!product || !product.tags?.includes("Hellfire Auction")) return null;

  const startingBid = Number(product.variants?.nodes?.[0]?.price) > 0
    ? Number(product.variants?.nodes?.[0]?.price)
    : 1;

  const startsAt = new Date("2026-09-27T18:20:00.000Z");
  const endsAt = new Date("2026-10-04T18:20:00.000Z");

  const restored = await prisma.auction.create({
    data: {
      shop,
      productId,
      title: "Test",
      description: product.descriptionHtml || "Testing Only",
      imageUrl: product.featuredImage?.url || null,
      startingBid,
      currentBid: 3,
      bidCount: 1,
      startsAt,
      endsAt,
      status: "LIVE",
    },
  });

  await prisma.bid.create({
    data: {
      auctionId: restored.id,
      bidderId: "31238385893487",
      amount: 3,
      maxBid: 3,
    },
  });

  return restored;
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

  let auction =
    await prisma.auction.findFirst({
      where: {
        shop,
        productId,
      },
      include: {
        bids: {
          orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
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

  if (!auction) {
    try {
      auction = await recoverMissingAuction(shop, productId);
    } catch (error) {
      console.error("[HELLFIRE AUCTION RECOVERY]", error);
    }
  }

  console.log("[HELLFIRE AUCTION PROXY]", JSON.stringify({
    shop,
    productId,
    found: Boolean(auction),
    auctionId: auction?.id || null,
    auctionStatus: auction ? auctionState(auction) : null,
    currentBid: auction?.currentBid ?? null,
    bidCount: auction?.bidCount ?? null,
  }));

  const publicBids = auction?.bids || [];
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || null;
  const myBid = loggedInCustomerId && auction
    ? await prisma.bid.findFirst({
        where: { auctionId: auction.id, bidderId: loggedInCustomerId },
        select: { maxBid: true },
      })
    : null;
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
          bidCount: auction.bidCount,
          minimumBid: publicBids.length > 0
            ? Number(auction.currentBid || 0) + bidIncrement(auction.currentBid)
            : Number(auction.startingBid),
          myMaximumBid: myBid ? Number(myBid.maxBid) : null,
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

function bidIncrement(currentBid) {
  const bid = Number(currentBid || 0);
  if (bid < 25) return 1;
  if (bid < 100) return 2;
  return 5;
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
    // Serialize bids for this auction so simultaneous bidders cannot both
    // calculate against the same stale current bid.
    await tx.$queryRaw`SELECT "id" FROM "Auction" WHERE "id" = ${auction.id} FOR UPDATE`;

    const current = await tx.auction.findUnique({ where: { id: auction.id } });
    if (!current) return { error: "Auction not found." };

    const transactionNow = new Date();
    if (transactionNow < current.startsAt) {
      return { error: "This auction has not started yet." };
    }
    if (transactionNow >= current.endsAt) {
      return { error: "This auction has ended." };
    }

    const currentBid = Number(current.currentBid || 0);
    const preBids = await tx.bid.findMany({
      where: { auctionId: current.id },
      orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
    });
    const increment = bidIncrement(currentBid);
    const minimumBid = preBids.length > 0
      ? currentBid + increment
      : Number(current.startingBid);
    const existing = preBids.find((bid) => bid.bidderId === customerId) || null;
    const oldMax = existing ? Number(existing.maxBid || existing.amount) : 0;
    const wasHighest = Boolean(existing && preBids[0]?.id === existing.id);

    if (amount < minimumBid) {
      return { error: "Your maximum bid must be at least the minimum bid." };
    }
    if (existing && amount <= oldMax) {
      return { error: "Your maximum bid is already at or above that amount." };
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
      data: { currentBid: displayedBid, bidCount: { increment: 1 } },
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
