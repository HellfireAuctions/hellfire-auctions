import { proxyAuth } from "../proxy-auth.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  // Always verify the Shopify app proxy signature (no localhost bypass).
  const { session } = await proxyAuth(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");

  if (!shop) {
    return Response.json({ error: "Missing shop." }, { status: 400 });
  }

  const auctions = await prisma.auction.findMany({
    where: { shop },
    select: { productId: true },
  });

  const auctionProductIds = auctions.map((auction) =>
    auction.productId.replace("gid://shopify/Product/", ""),
  );

  return Response.json({ auctionProductIds });
};
