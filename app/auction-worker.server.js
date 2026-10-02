import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";

const INTERVAL_MS = 15_000;
const RETRY_AFTER_MS = 2 * 60_000; // wait before retrying a failed settlement
const STALE_SETTLING_MS = 10 * 60_000; // recover a settlement that crashed mid-way
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000; // stop retrying a day after the auction ended

// Statuses used while settling: SETTLING, SETTLEMENT_RETRY, SETTLEMENT_FAILED, ENDED.
const NOT_DUE = ["ENDED", "SETTLEMENT_FAILED", "SETTLING", "SETTLEMENT_RETRY"];

// Uses the app library so expiring offline access tokens are refreshed automatically.
async function adminGraphql(shop, query, variables = {}) {
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(
      json.errors.map((e) => (typeof e === "string" ? e : e.message)).join(", "),
    );
  }
  return json.data;
}

function throwUserErrors(userErrors) {
  if (userErrors?.length) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }
}

async function createAndSendWinnerInvoice(auction, winnerId) {
  let draftOrderId = auction.winnerDraftOrderId || null;
  let checkoutUrl = auction.winnerCheckoutUrl || null;

  if (!draftOrderId) {
    const customerGid = String(winnerId).startsWith("gid://")
      ? String(winnerId)
      : `gid://shopify/Customer/${winnerId}`;

    const productData = await adminGraphql(
      auction.shop,
      `#graphql
        query AuctionVariant($productId: ID!) {
          product(id: $productId) {
            variants(first: 1) {
              nodes { id }
            }
          }
        }
      `,
      { productId: auction.productId },
    );

    const variantId = productData?.product?.variants?.nodes?.[0]?.id;
    if (!variantId) throw new Error("Auction product variant could not be found.");

    const draftData = await adminGraphql(
      auction.shop,
      `#graphql
        mutation CreateAuctionDraft($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }
      `,
      {
        input: {
          purchasingEntity: { customerId: customerGid },
          note: `Hellfire Auctions winner: ${auction.title}`,
          tags: ["Hellfire Auction"],
          lineItems: [
            {
              variantId,
              quantity: 1,
              originalUnitPrice: Number(auction.currentBid).toFixed(2),
            },
          ],
          customAttributes: [
            { key: "Hellfire Auction", value: auction.id },
            { key: "Winning Bid", value: Number(auction.currentBid).toFixed(2) },
          ],
        },
      },
    );

    throwUserErrors(draftData?.draftOrderCreate?.userErrors);
    const draft = draftData?.draftOrderCreate?.draftOrder;
    if (!draft?.id) throw new Error("Unable to create winner draft order.");

    draftOrderId = draft.id;
    checkoutUrl = draft.invoiceUrl || checkoutUrl;

    // Save immediately so a retry never creates a second draft order.
    await prisma.auction.update({
      where: { id: auction.id },
      data: { winnerDraftOrderId: draftOrderId, winnerCheckoutUrl: checkoutUrl },
    });
  }

  if (!auction.winnerNotifiedAt) {
    const invoiceData = await adminGraphql(
      auction.shop,
      `#graphql
        mutation SendAuctionInvoice($id: ID!) {
          draftOrderInvoiceSend(
            id: $id
            email: {
              subject: "You won the Hellfire Auction"
              customMessage: "Congratulations! You won the auction. Use the secure checkout link to complete your purchase."
            }
          ) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }
      `,
      { id: draftOrderId },
    );

    throwUserErrors(invoiceData?.draftOrderInvoiceSend?.userErrors);
    checkoutUrl =
      invoiceData?.draftOrderInvoiceSend?.draftOrder?.invoiceUrl || checkoutUrl;

    await prisma.auction.update({
      where: { id: auction.id },
      data: { winnerCheckoutUrl: checkoutUrl, winnerNotifiedAt: new Date() },
    });
  }

  return { draftOrderId, checkoutUrl };
}

async function removeFromLiveAuctions(auction) {
  try {
    const data = await adminGraphql(
      auction.shop,
      `#graphql
        query LiveAuctions {
          collections(first: 100, query: "title:'Live Auctions'") {
            nodes { id title }
          }
        }
      `,
    );

    const collection = data?.collections?.nodes?.find(
      (item) => item.title === "Live Auctions",
    );

    if (collection) {
      const result = await adminGraphql(
        auction.shop,
        `#graphql
          mutation RemoveEndedAuction($id: ID!, $productIds: [ID!]!) {
            collectionRemoveProducts(id: $id, productIds: $productIds) {
              userErrors { message }
            }
          }
        `,
        { id: collection.id, productIds: [auction.productId] },
      );
      throwUserErrors(result?.collectionRemoveProducts?.userErrors);
    }
  } catch (error) {
    console.error("[hellfire-auctions] collection cleanup failed:", error);
  }
}

async function settleAuction(auction) {
  // Claim the auction so two workers/instances can never settle it twice.
  const claimed = await prisma.auction.updateMany({
    where: { id: auction.id, status: auction.status, updatedAt: auction.updatedAt },
    data: { status: "SETTLING" },
  });
  if (claimed.count !== 1) return;

  try {
    const topBid = await prisma.bid.findFirst({
      where: { auctionId: auction.id },
      orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
    });

    const reserveMet =
      auction.reservePrice == null ||
      Number(auction.currentBid) >= Number(auction.reservePrice);

    const winnerId = topBid && reserveMet ? topBid.bidderId : null;

    let checkoutUrl = auction.winnerCheckoutUrl || null;
    let draftOrderId = auction.winnerDraftOrderId || null;

    if (winnerId) {
      ({ draftOrderId, checkoutUrl } = await createAndSendWinnerInvoice(
        auction,
        winnerId,
      ));
    }

    await prisma.auction.update({
      where: { id: auction.id },
      data: {
        status: "ENDED",
        winnerId,
        winnerCheckoutUrl: checkoutUrl,
        winnerDraftOrderId: draftOrderId,
      },
    });
  } catch (error) {
    const tooOld = Date.now() - new Date(auction.endsAt).getTime() > GIVE_UP_AFTER_MS;
    await prisma.auction.update({
      where: { id: auction.id },
      data: { status: tooOld ? "SETTLEMENT_FAILED" : "SETTLEMENT_RETRY" },
    });
    throw error;
  }

  await removeFromLiveAuctions(auction);
}

async function tick() {
  const now = new Date();

  // Keep DRAFT/UPCOMING/LIVE labels in step with the clock (never touches ended ones).
  await prisma.auction.updateMany({
    where: {
      startsAt: { lte: now },
      endsAt: { gt: now },
      status: { in: ["DRAFT", "UPCOMING"] },
    },
    data: { status: "LIVE" },
  });
  await prisma.auction.updateMany({
    where: { startsAt: { gt: now }, status: { in: ["DRAFT", "LIVE"] } },
    data: { status: "UPCOMING" },
  });

  const due = await prisma.auction.findMany({
    where: {
      endsAt: { lte: now },
      OR: [
        { status: { notIn: NOT_DUE } },
        {
          status: "SETTLEMENT_RETRY",
          updatedAt: { lt: new Date(now.getTime() - RETRY_AFTER_MS) },
        },
        {
          status: "SETTLING",
          updatedAt: { lt: new Date(now.getTime() - STALE_SETTLING_MS) },
        },
      ],
    },
    take: 25,
  });

  for (const auction of due) {
    try {
      console.log(`[hellfire-auctions] settling ${auction.id}`);
      await settleAuction(auction);
      console.log(`[hellfire-auctions] settled ${auction.id}`);
    } catch (error) {
      console.error(`[hellfire-auctions] failed to settle ${auction.id}:`, error);
    }
  }
}

async function runScheduledTick() {
  try {
    await tick();
  } catch (error) {
    console.error("[hellfire-auctions] scheduled tick failed:", error);
  } finally {
    globalThis.__HELLFIRE_AUCTION_WORKER__ = setTimeout(runScheduledTick, INTERVAL_MS);
  }
}

if (!globalThis.__HELLFIRE_AUCTION_WORKER__) {
  globalThis.__HELLFIRE_AUCTION_WORKER__ = true;
  runScheduledTick().catch((error) =>
    console.error("[hellfire-auctions] initial settlement failed:", error),
  );
}
