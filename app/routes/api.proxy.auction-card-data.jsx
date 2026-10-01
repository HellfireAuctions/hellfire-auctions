import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function state(a) {
  const now = new Date();
  if (now < a.startsAt) return "UPCOMING";
  if (now >= a.endsAt) return "ENDED";
  return "LIVE";
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const { session } = await authenticate.public.appProxy(request);
  const shop = session?.shop || url.searchParams.get("shop");
  if (!shop) return Response.json({ error: "Missing shop." }, { status: 400 });

  const auctions = await prisma.auction.findMany({
    where: { shop },
    select: { productId: true, currentBid: true, bidCount: true, startingBid: true, startsAt: true, endsAt: true, status: true },
  });

  return Response.json({ auctions: auctions.map((a) => ({
    productId: a.productId.replace("gid://shopify/Product/", ""),
    currentBid: Number(a.currentBid || a.startingBid || 0),
    bidCount: a.bidCount,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    status: state(a),
  })) });
};
