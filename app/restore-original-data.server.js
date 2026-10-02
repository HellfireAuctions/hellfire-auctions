// One-time, safe restore of the ORIGINAL auction data (exported read-only from the
// old Neon database on 2026-10-01) into whatever database this app is connected to.
//
// Rules this code follows:
//  - Never touches anything if the original auction already exists (idempotent).
//  - Only removes the placeholder auction that ChatGPT's temporary code created, and only
//    when it still looks exactly like that placeholder (same id, title "Test", <= 1 bid).
//  - Anything unexpected -> logs and does nothing. It never throws or blocks startup.
import { readFileSync } from "node:fs";
import path from "node:path";
import prisma from "./db.server.js";

const PLACEHOLDER_AUCTION_ID = "cmuqcny670000ou3fwm10gkh0";

function loadOriginal() {
  const file = path.join(process.cwd(), "prisma", "restore", "original-data.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

function toDate(value) {
  return value == null ? value : new Date(value);
}

async function restoreOriginalData() {
  const original = loadOriginal();

  for (const auction of original.auctions) {
    const already = await prisma.auction.findUnique({ where: { id: auction.id } });
    if (already) {
      console.log(`[restore] original auction ${auction.id} already present - nothing to do`);
      continue;
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const other = await tx.auction.findFirst({
        where: { shop: auction.shop, productId: auction.productId },
        include: { bids: true },
      });

      if (other) {
        const looksLikePlaceholder =
          other.id === PLACEHOLDER_AUCTION_ID &&
          other.title === "Test" &&
          other.bids.length <= 1;
        if (!looksLikePlaceholder) return "skipped: a different auction already exists for this product";
        await tx.auction.delete({ where: { id: other.id } }); // bids cascade
      }

      await tx.auction.create({
        data: {
          ...auction,
          startsAt: toDate(auction.startsAt),
          endsAt: toDate(auction.endsAt),
          createdAt: toDate(auction.createdAt),
          updatedAt: toDate(auction.updatedAt),
          winnerNotifiedAt: toDate(auction.winnerNotifiedAt),
        },
      });

      const bids = original.bids
        .filter((bid) => bid.auctionId === auction.id)
        .map((bid) => ({ ...bid, createdAt: toDate(bid.createdAt) }));
      await tx.bid.createMany({ data: bids, skipDuplicates: true });

      return `restored auction ${auction.id} with ${bids.length} bidder row(s)`;
    });

    console.log(`[restore] ${outcome}`);
  }
}

if (!globalThis.__HELLFIRE_RESTORE_RAN__) {
  globalThis.__HELLFIRE_RESTORE_RAN__ = true;
  restoreOriginalData().catch((error) =>
    console.error("[restore] failed (app keeps running):", error?.message || error),
  );
}
