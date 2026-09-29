import prisma from "./db.server.js";

const API_VERSION = "2026-10";
const INTERVAL_MS = 15_000;

async function adminGraphql(shop, accessToken, query, variables = {}) {
  const response = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  const json = await response.json();
  if (!response.ok || json.errors?.length) {
    throw new Error(json.errors?.map((e) => e.message).join(", ") || `Shopify API HTTP ${response.status}`);
  }

  return json.data;
}

async function settleAuction(auction) {
  const session = await prisma.session.findFirst({
    where: { shop: auction.shop },
    orderBy: { expires: "desc" },
  });

  if (!session?.accessToken) return;

  const bids = await prisma.bid.findMany({
    where: { auctionId: auction.id },
    orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
  });

  const highest = bids[0] || null;
  const reserveMet =
    auction.reservePrice == null ||
    Number(auction.currentBid) >= Number(auction.reservePrice);

  const winnerId = reserveMet ? highest?.bidderId || null : null;

  let checkoutUrl = auction.winnerCheckoutUrl || null;

  if (winnerId && !checkoutUrl) {
    const customerGid = String(winnerId).startsWith("gid://")
      ? String(winnerId)
      : `gid://shopify/Customer/${winnerId}`;

    const customerData = await adminGraphql(
      auction.shop,
      session.accessToken,
      `#graphql
        query WinnerCustomer($id: ID!) {
          customer(id: $id) {
            email
          }
          product(id: $productId) {
            variants(first: 1) {
              nodes {
                id
              }
            }
          }
        }
      `,
      { id: customerGid, productId: auction.productId },
    );

    const email = customerData?.customer?.email;
    const variantId = customerData?.product?.variants?.nodes?.[0]?.id;

    if (email && variantId) {
      const draftData = await adminGraphql(
        auction.shop,
        session.accessToken,
        `#graphql
          mutation CreateAuctionDraft($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder {
                id
                invoiceUrl
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          input: {
            email,
            note: `Hellfire Auctions winner: ${auction.title}`,
            lineItems: [{
              variantId,
              quantity: 1,
              originalUnitPrice: Number(auction.currentBid),
            }],
            customAttributes: [
              { key: "Hellfire Auction", value: auction.id },
              { key: "Winning Bid", value: String(auction.currentBid) },
            ],
          },
        },
      );

      const draft = draftData?.draftOrderCreate?.draftOrder;
      const draftErrors = draftData?.draftOrderCreate?.userErrors || [];

      if (draftErrors.length) {
        throw new Error(draftErrors.map((e) => e.message).join(", "));
      }

      if (draft?.id) {
        checkoutUrl = draft.invoiceUrl || null;

        const invoiceData = await adminGraphql(
          auction.shop,
          session.accessToken,
          `#graphql
            mutation SendAuctionInvoice($id: ID!) {
              draftOrderInvoiceSend(
                id: $id
                email: {
                  subject: "You won the Hellfire Auction"
                  customMessage: "Congratulations! You won the auction. Use the secure checkout link to complete your purchase."
                }
              ) {
                draftOrder {
                  id
                  invoiceUrl
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `,
          { id: draft.id },
        );

        const invoiceErrors =
          invoiceData?.draftOrderInvoiceSend?.userErrors || [];

        if (invoiceErrors.length) {
          throw new Error(invoiceErrors.map((e) => e.message).join(", "));
        }

        checkoutUrl =
          invoiceData?.draftOrderInvoiceSend?.draftOrder?.invoiceUrl ||
          checkoutUrl;
      }
    }
  }

  await prisma.auction.update({
    where: { id: auction.id },
    data: {
      status: "ENDED",
      winnerId,
      winnerCheckoutUrl: checkoutUrl,
      winnerNotifiedAt: checkoutUrl ? new Date() : undefined,
    },
  });

  // Remove ended auctions from the merchant's Live Auctions collection.
  try {
    const collections = await adminGraphql(
      auction.shop,
      session.accessToken,
      `#graphql
        query LiveAuctions {
          collections(first: 100, query: "title:'Live Auctions'") {
            nodes {
              id
              title
            }
          }
        }
      `,
    );

    const collection = collections?.collections?.nodes?.find(
      (item) => item.title === "Live Auctions",
    );

    if (collection) {
      await adminGraphql(
        auction.shop,
        session.accessToken,
        `#graphql
          mutation RemoveEndedAuction($id: ID!, $productIds: [ID!]!) {
            collectionRemoveProducts(id: $id, productIds: $productIds) {
              userErrors {
                message
              }
            }
          }
        `,
        { id: collection.id, productIds: [auction.productId] },
      );
    }
  } catch (error) {
    console.error("[hellfire-auctions] collection cleanup failed:", error);
  }
}

async function tick() {
  const now = new Date();

  // Keep persisted lifecycle state authoritative so the admin UI never shows
  // stale DRAFT/LIVE values after a restart or an interrupted write.
  await prisma.auction.updateMany({
    where: { endsAt: { gt: now } },
    data: { status: "LIVE" },
  });

  await prisma.auction.updateMany({
    where: { startsAt: { gt: now } },
    data: { status: "UPCOMING" },
  });

  const due = await prisma.auction.findMany({
    where: {
      endsAt: { lte: now },
      status: { not: "ENDED" },
    },
    take: 25,
  });

  if (due.length) {
    console.log(`[hellfire-auctions] settling ${due.length} expired auction(s)`);
  }

  for (const auction of due) {
    try {
      console.log(`[hellfire-auctions] settling ${auction.id}`);
      await settleAuction(auction);
      console.log(`[hellfire-auctions] settled ${auction.id}`);
    } catch (error) {
      console.error(
        `[hellfire-auctions] failed to settle ${auction.id}:`,
        error,
      );
    }
  }
}

async function runScheduledTick() {
  try {
    await tick();
  } catch (error) {
    console.error("[hellfire-auctions] scheduled tick failed:", error);
  } finally {
    globalThis.__HELLFIRE_AUCTION_WORKER__ = setTimeout(
      runScheduledTick,
      INTERVAL_MS,
    );
  }
}

if (!globalThis.__HELLFIRE_AUCTION_WORKER__) {
  globalThis.__HELLFIRE_AUCTION_WORKER__ = true;
  runScheduledTick().catch((error) =>
    console.error("[hellfire-auctions] initial settlement failed:", error),
  );
}
