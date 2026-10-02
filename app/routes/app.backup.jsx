import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Admin-only download of this store's auction data (auctions + every bid) as a JSON file.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const auctions = await prisma.auction.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "asc" },
    include: {
      bids: {
        orderBy: { createdAt: "asc" },
        select: { id: true, bidderId: true, amount: true, maxBid: true, createdAt: true },
      },
    },
  });
  const body = JSON.stringify(
    { app: "Hellfire Auctions", shop: session.shop, exportedAt: new Date().toISOString(), auctionCount: auctions.length, auctions },
    null,
    2,
  );
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="hellfire-auctions-backup-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
};
