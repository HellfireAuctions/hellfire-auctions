import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function stateFor(auction, now) {
  if (now < auction.startsAt) return "UPCOMING";
  if (now >= auction.endsAt) return "ENDED";
  return "LIVE";
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  let session;

  try {
    ({ session } = await authenticate.public.appProxy(request));
  } catch (error) {
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw error;
  }

  const shop = session?.shop || url.searchParams.get("shop");

  if (!shop) {
    return Response.json({ error: "Missing shop." }, { status: 400 });
  }

  const auctions = await prisma.auction.findMany({
    where: { shop },
    select: { productId: true, startsAt: true, endsAt: true },
  });

  const now = new Date();
  const auctionProductIds = auctions
    .filter((auction) => {
      const state = stateFor(auction, now);
      return state === "LIVE" || state === "UPCOMING";
    })
    .map((auction) => auction.productId.replace("gid://shopify/Product/", ""));

  return Response.json({ auctionProductIds });
};
