import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  let session;

  const localDev = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (!localDev) {
    ({ session } = await authenticate.public.appProxy(request));
  }

  const shop = session?.shop || url.searchParams.get("shop");

  if (!shop) {
    return Response.json({ error: "Missing shop." }, { status: 400 });
  }

  const auctions = await prisma.auction.findMany({
    where: { shop },
    select: { productId: true, startsAt: true, endsAt: true },
  });

  const auctionProductIds = auctions
    .map((auction) => auction.productId.replace("gid://shopify/Product/", ""));

  return Response.json({ auctionProductIds });
};
