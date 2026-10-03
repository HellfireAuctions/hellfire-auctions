import { randomUUID as hfUuid } from "node:crypto";
import { formatMoney } from "./currency.server.js";
import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";
import { sendEndingSoonReminders, notifyMerchantEnded, notifyReserveNotMet, alertOwner, sendWinnerInvoiceFallback, notifyWinner, sendPaymentReminder, notifyMerchantUnpaid, notifyLosers } from "./notifications.server.js";

const ENDING_SOON_WINDOW_MS = 60 * 60_000;
const RETRY_AFTER_MS = 2 * 60_000; // wait before retrying a failed settlement
const STALE_SETTLING_MS = 10 * 60_000; // recover a settlement that crashed mid-way
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000; // stop retrying a day after the auction ended

// Statuses used while settling: SETTLING, SETTLEMENT_RETRY, SETTLEMENT_FAILED, ENDED.
const NOT_DUE = ["ENDED", "SETTLEMENT_FAILED", "SETTLING", "SETTLEMENT_RETRY", "CANCELLED"];

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

async function createAndSendWinnerInvoice(auction, winnerId, opts = {}) {
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
          shop { currencyCode }
          product(id: $productId) {
            title
            variants(first: 1) {
              nodes {
                id
                sku
                taxable
                inventoryItem {
                  requiresShipping
                  measurement { weight { value unit } }
                }
              }
            }
          }
        }
      `,
      { productId: auction.productId },
    );

    const variant = productData?.product?.variants?.nodes?.[0];
    if (!variant?.id) throw new Error("Auction product variant could not be found.");

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
              variantId: variant.id,
              quantity: 1,
              priceOverride: {
                amount: Number(auction.currentBid).toFixed(2),
                currencyCode: productData?.shop?.currencyCode || "USD",
              },
            },
          ],
          customAttributes: [
            { key: "Auction ID", value: auction.id },
            { key: "Winning bid", value: Number(auction.currentBid).toFixed(2) },
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
    // Primary: our own email (photo, price, deadline, secure checkout link). Shopify's invoice email
    // is only the backup, so the winner gets exactly one email.
    const emailed = await notifyWinner({ auction, customerId: winnerId, checkoutUrl, secondChance: Boolean(opts.secondChance) });
    if (emailed) {
      await prisma.auction.update({
        where: { id: auction.id },
        data: { winnerCheckoutUrl: checkoutUrl, winnerNotifiedAt: new Date() },
      });
    } else {
    // Customer-facing invoice email carries the store's own name (no app branding).
    const shopInfo = await adminGraphql(
      auction.shop,
      `#graphql
        query InvoiceShopName { shop { name currencyCode } }
      `,
    );
    const shopName = shopInfo?.shop?.name || "our store";
    const invoiceData = await adminGraphql(
      auction.shop,
      `#graphql
        mutation SendAuctionInvoice($id: ID!, $email: EmailInput) {
          draftOrderInvoiceSend(id: $id, email: $email) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }
      `,
      {
        id: draftOrderId,
        email: {
          subject: opts.secondChance ? `A second chance to buy "${auction.title}" at ${shopName}` : `You won the auction at ${shopName}!`,
          customMessage: opts.secondChance ? `Good news! The original winner didn't complete the purchase, so "${auction.title}" is now offered to you at ${formatMoney(auction.currentBid, shopInfo?.shop?.currencyCode)}. Use the secure checkout link below to buy it. Please pay within 4 days.` : `Congratulations! You won "${auction.title}" with a winning bid of ${formatMoney(auction.currentBid, shopInfo?.shop?.currencyCode)}. Use the secure checkout link below to complete your purchase. Please pay within 4 days.`,
        },
      },
    );

    const invoiceErrors = invoiceData?.draftOrderInvoiceSend?.userErrors || [];
    if (invoiceErrors.length) {
      // Shopify couldn't email the invoice (often an unverified store sender email).
      // Send the same secure checkout link ourselves so the winner can still pay.
      const sent = await sendWinnerInvoiceFallback({ auction, customerId: winnerId, checkoutUrl });
      if (!sent) throwUserErrors(invoiceErrors);
      alertOwner("invoice-sender-" + auction.shop, "Shopify couldn't send a winner invoice", [
        `Store: ${auction.shop}. Shopify said: ${invoiceErrors.map((e) => e.message).join(", ")}`,
        "The app emailed the winner their secure checkout link instead, so the sale can still go through.",
        "To fix it for next time: Shopify admin > Settings > Notifications > Sender email, and verify that address.",
      ]);
    } else {
      checkoutUrl =
        invoiceData?.draftOrderInvoiceSend?.draftOrder?.invoiceUrl || checkoutUrl;
    }

    await prisma.auction.update({
      where: { id: auction.id },
      data: { winnerCheckoutUrl: checkoutUrl, winnerNotifiedAt: new Date() },
    });
    }
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

  const settled = await prisma.auction.findUnique({ where: { id: auction.id } });
  if (settled) {
    const reserveMet = settled.reservePrice == null || Number(settled.currentBid) >= Number(settled.reservePrice);
    notifyMerchantEnded({ auction: settled, winnerId: settled.winnerId, reserveMet });
    if (settled.winnerId) notifyLosers({ auction: settled });
    if (!settled.winnerId && !reserveMet) {
      const top = await prisma.bid.findFirst({
        where: { auctionId: settled.id },
        orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
      });
      if (top) notifyReserveNotMet({ auction: settled, customerId: top.bidderId });
    }
  }
}

let zeroDraftsRepaired = false;
async function repairZeroPriceDrafts() {
  if (zeroDraftsRepaired) return;
  zeroDraftsRepaired = true;
  const recent = await prisma.auction.findMany({
    where: { winnerDraftOrderId: { not: null }, endsAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
    take: 50,
  });
  for (const a of recent) {
    try {
      if (!(Number(a.currentBid) > 0)) continue;
      const d = await adminGraphql(
        a.shop,
        `#graphql
          query DraftPriceCheck($id: ID!) {
            shop { currencyCode }
            draftOrder(id: $id) {
              status
              totalPriceSet { shopMoney { amount } }
              lineItems(first: 5) { nodes { quantity variant { id } } }
            }
          }
        `,
        { id: a.winnerDraftOrderId },
      );
      const draft = d?.draftOrder;
      // Unpaid drafts are OPEN or INVOICE_SENT; never touch COMPLETED (paid) ones.
      if (!draft || !["OPEN", "INVOICE_SENT"].includes(draft.status) || Number(draft.totalPriceSet?.shopMoney?.amount) > 0) {
        console.log("[hellfire-auctions] draft check", JSON.stringify({ auctionId: a.id, status: draft?.status || null, total: draft?.totalPriceSet?.shopMoney?.amount ?? null }));
        continue;
      }
      const variantId = draft.lineItems?.nodes?.[0]?.variant?.id;
      if (!variantId) continue;
      const u = await adminGraphql(
        a.shop,
        `#graphql
          mutation FixDraftPrice($id: ID!, $input: DraftOrderInput!) {
            draftOrderUpdate(id: $id, input: $input) {
              draftOrder { id totalPriceSet { shopMoney { amount } } }
              userErrors { field message }
            }
          }
        `,
        {
          id: a.winnerDraftOrderId,
          input: {
            lineItems: [
              {
                variantId,
                quantity: 1,
                priceOverride: { amount: Number(a.currentBid).toFixed(2), currencyCode: d?.shop?.currencyCode || "USD" },
              },
            ],
          },
        },
      );
      throwUserErrors(u?.draftOrderUpdate?.userErrors);
      console.log("[hellfire-auctions] fixed $0 winner draft", JSON.stringify({ auctionId: a.id, total: u?.draftOrderUpdate?.draftOrder?.totalPriceSet?.shopMoney?.amount }));
    } catch (error) {
      console.error("[hellfire-auctions] draft price repair failed:", a.id, error?.message || error);
    }
  }
}

let inventoryLocked = false;
async function lockExistingAuctionInventory() {
  if (inventoryLocked) return;
  inventoryLocked = true;
  if (await repairDone("STOCK_REPAIR_V2")) return;
  const rows = await prisma.auction.findMany({ where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }, orderBy: { createdAt: "desc" }, select: { shop: true, productId: true, winnerDraftOrderId: true }, distinct: ["shop", "productId"] });
  for (const r of rows) {
    try {
      if (r.winnerDraftOrderId) {
        const st = await adminGraphql(r.shop, `#graphql
          query PaidCheck($id: ID!) { draftOrder(id: $id) { status } }`, { id: r.winnerDraftOrderId });
        if (st?.draftOrder?.status === "COMPLETED") continue; // paid and shipped: leave at 0
      }
      const d = await adminGraphql(
        r.shop,
        `#graphql
          query LockLookup($id: ID!) {
            product(id: $id) { variants(first: 1) { nodes { id inventoryItem { id } } } }
            locations(first: 1) { nodes { id } }
          }
        `,
        { id: r.productId },
      );
      const variant = d?.product?.variants?.nodes?.[0];
      const locationId = d?.locations?.nodes?.[0]?.id;
      if (!variant?.inventoryItem?.id || !locationId) continue;
      await adminGraphql(
        r.shop,
        `#graphql
          mutation LockStock($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
            inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
              userErrors { message }
            }
          }
        `,
        {
          input: {
            name: "available",
            reason: "correction",
            quantities: [{ inventoryItemId: variant.inventoryItem.id, locationId, quantity: 1, changeFromQuantity: null }],
          },
          idempotencyKey: hfUuid(),
        },
      );
      await adminGraphql(
        r.shop,
        `#graphql
          mutation LockPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
          }
        `,
        { productId: r.productId, variants: [{ id: variant.id, inventoryPolicy: "DENY", price: "99999.00" }] },
      );
      console.log("[hellfire-auctions] auction item set to in-stock with placeholder price", r.productId);
    } catch (error) {
      console.error("[hellfire-auctions] stock lock failed:", r.productId, error?.message || error);
    }
  }
  await markRepairDone("STOCK_REPAIR_V2");
}

const SYS = { auctionId: "__system__", customerId: "__system__", key: "1" };
async function repairDone(type) {
  return Boolean(await prisma.auctionNotification.findFirst({ where: { ...SYS, type } }));
}
async function markRepairDone(type) {
  await prisma.auctionNotification.create({ data: { ...SYS, type } }).catch(() => {});
}

// One-time: put winner orders that were switched to custom lines back onto the product (with its photo).
let draftsRestored = false;
async function restoreVariantDrafts() {
  if (draftsRestored) return;
  draftsRestored = true;
  if (await repairDone("DRAFT_RESTORE_V2")) return;
  const rows = await prisma.auction.findMany({
    where: { winnerDraftOrderId: { not: null }, endsAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
    take: 100,
  });
  for (const a of rows) {
    try {
      const d = await adminGraphql(
        a.shop,
        `#graphql
          query DraftKind($id: ID!, $productId: ID!) {
            shop { currencyCode }
            draftOrder(id: $id) { status lineItems(first: 5) { nodes { custom } } }
            product(id: $productId) { variants(first: 1) { nodes { id } } }
          }
        `,
        { id: a.winnerDraftOrderId, productId: a.productId },
      );
      const draft = d?.draftOrder;
      if (!draft || !["OPEN", "INVOICE_SENT"].includes(draft.status)) continue;
      const first = draft.lineItems?.nodes?.[0];
      if (!first || !first.custom) continue;
      const variantId = d?.product?.variants?.nodes?.[0]?.id;
      if (!variantId) continue;
      const u = await adminGraphql(
        a.shop,
        `#graphql
          mutation RestoreDraftLine($id: ID!, $input: DraftOrderInput!) {
            draftOrderUpdate(id: $id, input: $input) {
              draftOrder { id totalPriceSet { shopMoney { amount } } }
              userErrors { field message }
            }
          }
        `,
        {
          id: a.winnerDraftOrderId,
          input: {
            lineItems: [
              {
                variantId,
                quantity: 1,
                priceOverride: { amount: Number(a.currentBid).toFixed(2), currencyCode: d?.shop?.currencyCode || "USD" },
              },
            ],
          },
        },
      );
      throwUserErrors(u?.draftOrderUpdate?.userErrors);
      console.log("[hellfire-auctions] winner order restored to product line", JSON.stringify({ auctionId: a.id, total: u?.draftOrderUpdate?.draftOrder?.totalPriceSet?.shopMoney?.amount }));
    } catch (error) {
      console.error("[hellfire-auctions] draft restore failed:", a.id, error?.message || error);
    }
  }
  await markRepairDone("DRAFT_RESTORE_V2");
}

async function draftStatus(shop, draftId) {
  if (!draftId) return null;
  try {
    const d = await adminGraphql(shop, `#graphql
      query DraftStatus($id: ID!) { draftOrder(id: $id) { status } }`, { id: draftId });
    return d?.draftOrder?.status || null;
  } catch {
    return null;
  }
}

async function deleteDraft(shop, draftId) {
  if (!draftId) return;
  try {
    await adminGraphql(shop, `#graphql
      mutation DropDraft($input: DraftOrderDeleteInput!) {
        draftOrderDelete(input: $input) { deletedId userErrors { message } }
      }`, { input: { id: draftId } });
  } catch (error) {
    console.error("[hellfire-auctions] could not delete draft:", draftId, error?.message || error);
  }
}

// Reminders at 24h and 72h after the invoice; alert the store owner at 96h. Paid orders are skipped.
let lastFollowUp = 0;
async function paymentFollowUps() {
  if (Date.now() - lastFollowUp < 25 * 60_000) return;
  lastFollowUp = Date.now();
  const rows = await prisma.auction.findMany({
    where: {
      status: "ENDED",
      winnerId: { not: null },
      winnerDraftOrderId: { not: null },
      winnerNotifiedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
    },
    take: 50,
  });
  for (const a of rows) {
    try {
      const st = await draftStatus(a.shop, a.winnerDraftOrderId);
      if (st !== "OPEN" && st !== "INVOICE_SENT") continue;
      const hours = (Date.now() - new Date(a.winnerNotifiedAt).getTime()) / 3600_000;
      if (hours >= 96) await notifyMerchantUnpaid({ auction: a });
      else if (hours >= 72) await sendPaymentReminder({ auction: a, key: "d3" });
      else if (hours >= 24) await sendPaymentReminder({ auction: a, key: "d1" });
    } catch (error) {
      console.error("[hellfire-auctions] payment follow-up failed:", a.id, error?.message || error);
    }
  }
}

// ----- merchant actions on an unpaid winner -----
export async function remindWinnerNow(shop, auctionId) {
  const a = await prisma.auction.findFirst({ where: { id: auctionId, shop } });
  if (!a?.winnerId) return { error: "This auction has no winner." };
  if ((await draftStatus(shop, a.winnerDraftOrderId)) === "COMPLETED") return { error: "The winner already paid." };
  const r = await sendPaymentReminder({ auction: a, key: "manual-" + Date.now() });
  if (r.sent) return { success: "Reminder sent to the winner." };
  return { error: r.reason === "plan" ? "Reminder emails are part of the Blaze plan." : "Couldn't send the reminder. Please try again." };
}

export async function cancelUnpaidSale(shop, auctionId) {
  const a = await prisma.auction.findFirst({ where: { id: auctionId, shop } });
  if (!a?.winnerId) return { error: "This auction has no winner." };
  if ((await draftStatus(shop, a.winnerDraftOrderId)) === "COMPLETED") return { error: "The winner already paid, so the sale can't be cancelled here." };
  await deleteDraft(shop, a.winnerDraftOrderId);
  await prisma.auction.update({
    where: { id: a.id },
    data: { winnerId: null, winnerCheckoutUrl: null, winnerDraftOrderId: null, winnerNotifiedAt: null },
  });
  return { success: "Sale cancelled. You can now relist this item or sell it again." };
}

export async function offerToNextBidder(shop, auctionId) {
  const a = await prisma.auction.findFirst({ where: { id: auctionId, shop } });
  if (!a?.winnerId) return { error: "This auction has no winner to replace." };
  if (new Date() < a.endsAt) return { error: "The auction hasn't ended yet." };
  if ((await draftStatus(shop, a.winnerDraftOrderId)) === "COMPLETED") return { error: "The winner already paid." };
  const bids = await prisma.bid.findMany({ where: { auctionId: a.id }, orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }] });
  const blocked = new Set((await prisma.blockedBidder.findMany({ where: { shop }, select: { customerId: true } })).map((b) => b.customerId));
  const next = bids.find((b) => b.bidderId !== a.winnerId && !blocked.has(b.bidderId));
  if (!next) return { error: "There's no other bidder to offer this item to." };
  const price = Number(next.maxBid);
  await deleteDraft(shop, a.winnerDraftOrderId);
  const updated = await prisma.auction.update({
    where: { id: a.id },
    data: { winnerId: next.bidderId, currentBid: price, winnerDraftOrderId: null, winnerCheckoutUrl: null, winnerNotifiedAt: null },
  });
  const { draftOrderId, checkoutUrl } = await createAndSendWinnerInvoice(updated, next.bidderId, { secondChance: true });
  await prisma.auction.update({ where: { id: a.id }, data: { winnerDraftOrderId: draftOrderId, winnerCheckoutUrl: checkoutUrl } });
  return { success: `Second-chance offer sent to the next bidder at ${formatMoney(price, await shopCurrencyCode(shop))}.` };
}

async function shopCurrencyCode(shop) {
  try {
    const d = await adminGraphql(shop, `#graphql
      query ShopCur { shop { currencyCode } }`);
    return d?.shop?.currencyCode || "USD";
  } catch {
    return "USD";
  }
}

let winnerCatchUpDone = false;
async function winnerCatchUpOnce() {
  if (winnerCatchUpDone) return;
  winnerCatchUpDone = true;
  if (await repairDone("WINNER_CATCHUP_V3")) return;
  const rows = await prisma.auction.findMany({
    where: {
      status: "ENDED",
      winnerId: { not: null },
      winnerCheckoutUrl: { not: null },
      endsAt: { gte: new Date(Date.now() - 3 * 3600_000) },
    },
    take: 25,
  });
  for (const a of rows) {
    await notifyWinner({ auction: a, customerId: a.winnerId, checkoutUrl: a.winnerCheckoutUrl });
  }
  await markRepairDone("WINNER_CATCHUP_V3");
}

async function tick() {
  await winnerCatchUpOnce().catch((error) => console.error("[hellfire-auctions] winner catch-up error:", error?.message || error));
  await lockExistingAuctionInventory().catch((error) => console.error("[hellfire-auctions] stock lock error:", error?.message || error));
  await restoreVariantDrafts().catch((error) => console.error("[hellfire-auctions] draft restore error:", error?.message || error));
  await paymentFollowUps().catch((error) => console.error("[hellfire-auctions] payment follow-ups error:", error?.message || error));
  const now = new Date();

  // Keep DRAFT/UPCOMING/LIVE labels in step with the clock (never touches ended ones).
  // Scheduled auctions: publish the hidden product at the start time, then mark LIVE.
  const starting = await prisma.auction.findMany({
    where: { startsAt: { lte: now }, endsAt: { gt: now }, status: { in: ["DRAFT", "UPCOMING"] } },
    take: 25,
  });
  for (const auction of starting) {
    try {
      const result = await adminGraphql(
        auction.shop,
        `#graphql
          mutation PublishAuctionProduct($product: ProductUpdateInput!) {
            productUpdate(product: $product) { userErrors { message } }
          }`,
        { product: { id: auction.productId, status: "ACTIVE" } },
      );
      throwUserErrors(result?.productUpdate?.userErrors);
      await prisma.auction.update({ where: { id: auction.id }, data: { status: "LIVE" } });
      console.log("[hellfire-auctions] auction started, product published:", auction.id);
    } catch (error) {
      console.error(`[hellfire-auctions] could not publish ${auction.id}:`, error?.message || error);
      alertOwner("publish-" + auction.id, "A scheduled auction could not go live", [
        `Auction "${auction.title}" in ${auction.shop} reached its start time but its product could not be published.`,
        String(error?.message || error).slice(0, 300),
      ]);
    }
  }
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

  try {
    await sendEndingSoonReminders();
  } catch (error) {
    console.error("[notify] reminder pass failed:", error?.message || error);
  }

  for (const auction of due) {
    try {
      console.log(`[hellfire-auctions] settling ${auction.id}`);
      await settleAuction(auction);
      console.log(`[hellfire-auctions] settled ${auction.id}`);
    } catch (error) {
      console.error(`[hellfire-auctions] failed to settle ${auction.id}:`, error);
      alertOwner("settle-" + auction.id, "An auction could not be settled", [
        `Auction "${auction.title}" (${auction.id}) in ${auction.shop} ended but the winner could not be invoiced yet.`,
        `Error: ${String(error?.message || error).slice(0, 300)}`,
        "The app retries automatically every 2 minutes for 24 hours.",
      ]);
    }
  }
}

const MIN_SLEEP_MS = 5_000;
const MAX_SLEEP_MS = 30 * 60_000; // safety net: never sleep longer than 30 minutes
let workerTimer = null;

// Works out when the next start, end, 1-hour reminder or retry is due.
async function nextDelayMs() {
  const now = new Date();
  const hourAhead = new Date(now.getTime() + ENDING_SOON_WINDOW_MS);
  const [nextStart, nextEnd, nextReminder, retrying, inLastHour] = await Promise.all([
    prisma.auction.findFirst({ where: { startsAt: { gt: now } }, orderBy: { startsAt: "asc" }, select: { startsAt: true } }),
    prisma.auction.findFirst({ where: { endsAt: { gt: now } }, orderBy: { endsAt: "asc" }, select: { endsAt: true } }),
    prisma.auction.findFirst({ where: { endsAt: { gt: hourAhead } }, orderBy: { endsAt: "asc" }, select: { endsAt: true } }),
    prisma.auction.count({ where: { status: { in: ["SETTLEMENT_RETRY", "SETTLING"] } } }),
    prisma.auction.count({ where: { endsAt: { gt: now, lte: hourAhead } } }),
  ]);
  const waits = [MAX_SLEEP_MS];
  const unpaidWatch = await prisma.auction.count({
    where: { status: "ENDED", winnerId: { not: null }, winnerNotifiedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } },
  });
  if (unpaidWatch) waits.push(30 * 60_000);
  if (nextStart) waits.push(nextStart.startsAt.getTime() - now.getTime() + 1000);
  if (nextEnd) waits.push(nextEnd.endsAt.getTime() - now.getTime() + 1000);
  if (nextReminder) waits.push(nextReminder.endsAt.getTime() - ENDING_SOON_WINDOW_MS - now.getTime() + 1000);
  if (retrying) waits.push(RETRY_AFTER_MS + 1000);
  if (inLastHour) waits.push(60_000); // last hour: check each minute so new bidders get their reminder
  return Math.max(MIN_SLEEP_MS, Math.min(...waits));
}

function schedule(ms) {
  clearTimeout(workerTimer);
  workerTimer = setTimeout(runScheduledTick, ms);
  globalThis.__HELLFIRE_AUCTION_WORKER__ = workerTimer;
}

async function runScheduledTick() {
  let delay = 60_000;
  try {
    await tick();
    delay = await nextDelayMs();
  } catch (error) {
    console.error("[hellfire-auctions] scheduled tick failed:", error);
    alertOwner("worker-tick", "The auction worker hit an error", [String(error?.message || error).slice(0, 300), "Auctions may not end or settle until this is fixed."]);
  } finally {
    schedule(delay);
  }
}

// Called after the merchant creates, relists or cancels an auction.
export function wakeWorker() {
  schedule(1000);
}

if (!globalThis.__HELLFIRE_AUCTION_WORKER__) {
  globalThis.__HELLFIRE_AUCTION_WORKER__ = true;
  runScheduledTick().catch((error) =>
    console.error("[hellfire-auctions] initial settlement failed:", error),
  );
}
