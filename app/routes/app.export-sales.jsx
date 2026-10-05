import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildSalesCsv } from "../sales-export";

// Admin-only sales report: every auction from the last 24 months as a CSV for Excel or Google Sheets.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const since = new Date(Date.now() - 24 * 31 * 24 * 3600_000);
  const auctions = await prisma.auction.findMany({
    where: { shop: session.shop, createdAt: { gte: since } },
    orderBy: { endsAt: "desc" },
    take: 5000,
    select: {
      id: true,
      title: true,
      status: true,
      startsAt: true,
      endsAt: true,
      startingBid: true,
      currentBid: true,
      bidCount: true,
      reservePrice: true,
      winnerId: true,
      winnerNotifiedAt: true,
      isTest: true,
    },
  });
  const marks = auctions.length
    ? await prisma.auctionNotification.findMany({
        where: { type: "PAID", auctionId: { in: auctions.map((a) => a.id) } },
        select: { auctionId: true, sentAt: true },
      })
    : [];
  const paid = new Map(marks.map((m) => [m.auctionId, m.sentAt]));
  const date = new Date().toISOString().slice(0, 10);
  return new Response(buildSalesCsv(auctions, paid), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="hellfire-auctions-sales-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
