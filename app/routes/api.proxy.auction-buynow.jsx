import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buyNowAvailable } from "../bidding.server";
import { wakeWorker } from "../auction-worker.server";

// A shopper buys the item at its Buy It Now price. The auction is claimed atomically: either this
// purchase wins (the auction ends now with this buyer as the winner) or a bid got there first.
const lastTry = new Map();

export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!customerId) return Response.json({ error: "Please sign in to buy." }, { status: 401 });
  if (Date.now() - (lastTry.get(customerId) || 0) < 2000) {
    return Response.json({ error: "Please wait a moment and try again." }, { status: 429 });
  }
  if (lastTry.size > 10000) lastTry.clear();
  lastTry.set(customerId, Date.now());

  const form = await request.formData();
  const raw = (form.get("product_id") || url.searchParams.get("product_id") || "").toString();
  const productId = raw.startsWith("gid://") ? raw : "gid://shopify/Product/" + raw.replace(/\D/g, "");
  if (!shop || productId.endsWith("/")) {
    return Response.json({ error: "Missing item." }, { status: 400 });
  }

  const blocked = await prisma.blockedBidder.findUnique({ where: { shop_customerId: { shop, customerId } } });
  if (blocked) return Response.json({ error: "You can't buy from this store's auctions." }, { status: 403 });

  const a = await prisma.auction.findFirst({ where: { shop, productId }, orderBy: { createdAt: "desc" } });
  const now = new Date();
  if (!a || a.buyNowPrice == null) return Response.json({ error: "Buy It Now isn't available for this item." }, { status: 404 });
  if (now < a.startsAt || now >= a.endsAt) return Response.json({ error: "This auction isn't running right now." }, { status: 400 });
  if (!buyNowAvailable(a)) {
    return Response.json({ error: "Sorry, Buy It Now is no longer available. Someone has already bid on this item." }, { status: 409 });
  }

  const price = Number(a.buyNowPrice);
  const claimed = await prisma.$transaction(async (tx) => {
    const res = await tx.auction.updateMany({
      where: {
        id: a.id,
        endsAt: { gt: now },
        status: { notIn: ["ENDED", "SETTLING", "SETTLEMENT_RETRY", "SETTLEMENT_FAILED", "CANCELLED"] },
        ...(a.reservePrice != null ? { currentBid: { lt: a.reservePrice } } : { bidCount: 0 }),
      },
      data: { currentBid: price, bidCount: { increment: 1 }, endsAt: now },
    });
    if (res.count !== 1) return false;
    await tx.bid.upsert({
      where: { auctionId_bidderId: { auctionId: a.id, bidderId: customerId } },
      create: { auctionId: a.id, bidderId: customerId, amount: price, maxBid: price },
      update: { amount: price, maxBid: price, createdAt: new Date() },
    });
    return true;
  });

  if (!claimed) {
    return Response.json({ error: "Sorry, someone bid just before you, so Buy It Now is no longer available." }, { status: 409 });
  }

  console.log("[buy-now]", JSON.stringify({ auctionId: a.id, customerId, price }));
  wakeWorker();
  return Response.json({ success: true, message: "You bought it! We're sending your checkout link by email." });
};
