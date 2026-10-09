import { randomUUID as hfUuid } from "node:crypto";
import { formatMoney } from "./currency.server.js";
import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";
import { isDevelopmentStore, canCreateAuction } from "./plans.server.js";
import { sendEndingSoonReminders, notifyMerchantEnded, notifyReserveNotMet, alertOwner, sendWinnerInvoiceFallback, notifyWinner, sendPaymentReminder, notifyMerchantUnpaid, notifyLosers, notifyWatchersStarted, sendWatcherReminders, notifyMerchantTestEnded, emailEncryptedBackup, notifyMerchantEmbedOff, notifyMerchantProductGone, notifyCombinedInvoice, notifyJoinedInvoice, notifyMerchantAutoOffer, notifyMerchantSettleFailed } from "./notifications.server.js";
import { getShopSettings, recordStrike } from "./settings.server.js";
import { publish } from "./live-hub.server.js";
import { selfTestIfDue, selfTestAfterBoot } from "./self-test.server.js";
import { orphanSweepIfDue, orphanSweepAfterBoot } from "./orphan-sweep.server.js";
import { startDropsFollowUp } from "./drops-followup.server.js";
import { memoDelete } from "./memo.server.js";

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
  // Inventory apps or manual edits can set the item to 0, which would break the winner's checkout.
  await ensureInvoiceStock(auction).catch((error) => console.error("[hellfire-auctions] stock re-check failed:", error?.message || error));
  // A buyer who already combined their wins into one unpaid invoice gets new wins added to it.
  if (!auction.winnerDraftOrderId && !opts.secondChance) {
    const joined = await tryJoinCombinedInvoice(auction, winnerId);
    if (joined) return joined;
  }
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

// Development stores can't take real payments, so tests there run the whole flow (reviewers need that).
const devStoreCache = new Map();
async function isDevStore(shop) {
  if (devStoreCache.has(shop)) return devStoreCache.get(shop);
  let dev = false;
  try {
    const { admin } = await unauthenticated.admin(shop);
    dev = await isDevelopmentStore(admin);
  } catch {
    dev = false;
  }
  devStoreCache.set(shop, dev);
  return dev;
}

async function settleAuction(auction) {
  // Claim the auction so two workers/instances can never settle it twice.
  const claimed = await prisma.auction.updateMany({
    where: { id: auction.id, status: auction.status, updatedAt: auction.updatedAt },
    data: { status: "SETTLING" },
  });
  if (claimed.count !== 1) return;

  let testOnLiveStore = false;
  let testTopBidder = null;
  let productGone = false;

  try {
    const topBid = await prisma.bid.findFirst({
      where: { auctionId: auction.id },
      orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
    });

    const reserveMet =
      auction.reservePrice == null ||
      Number(auction.currentBid) >= Number(auction.reservePrice);

    // A test auction on a live store can never produce a winner, an order or an invoice.
    testOnLiveStore = Boolean(auction.isTest) && !(await isDevStore(auction.shop));
    testTopBidder = topBid && reserveMet ? topBid.bidderId : null;
    let winnerId = topBid && reserveMet && !testOnLiveStore ? topBid.bidderId : null;
    if (winnerId && !(await productStillExists(auction))) {
      winnerId = null;
      productGone = true;
    }

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
    // Everyone watching sees the final result (winner, "you won", "reserve not met") straight away.
    memoDelete("auction:" + auction.shop + "|" + auction.productId);
    publish(auction.id, "update");
  } catch (error) {
    const tooOld = Date.now() - new Date(auction.endsAt).getTime() > GIVE_UP_AFTER_MS;
    await prisma.auction.update({
      where: { id: auction.id },
      data: { status: tooOld ? "SETTLEMENT_FAILED" : "SETTLEMENT_RETRY" },
    });
    throw error;
  }

  await removeFromLiveAuctions(auction).catch((error) => console.error("[hellfire-auctions] could not remove from Live Auctions:", error?.message || error));

  const settled = await prisma.auction.findUnique({ where: { id: auction.id } });
  if (settled && productGone) {
    notifyMerchantProductGone({ auction: settled }).catch(() => {});
    return;
  }
  if (settled && testOnLiveStore) {
    notifyMerchantTestEnded({ auction: settled, topBidderId: testTopBidder }).catch(() => {});
    return;
  }
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
  const seenDrafts = new Set();
  for (const a of rows) {
    if (seenDrafts.has(a.winnerDraftOrderId)) continue; // a combined invoice is followed up once
    seenDrafts.add(a.winnerDraftOrderId);
    try {
      const st = await draftStatus(a.shop, a.winnerDraftOrderId);
      if (st !== "OPEN" && st !== "INVOICE_SENT") continue;
      const hours = (Date.now() - new Date(a.winnerNotifiedAt).getTime()) / 3600_000;
      if (hours >= 96) {
        const handled = await autoSecondChance(a).catch((error) => {
          console.error("[hellfire-auctions] automatic second chance failed:", a.id, error?.message || error);
          return false;
        });
        if (!handled) await notifyMerchantUnpaid({ auction: a });
      }
      else if (hours >= 72) await sendPaymentReminder({ auction: a, key: "d3" });
      else if (hours >= 24) await sendPaymentReminder({ auction: a, key: "d1" });
    } catch (error) {
      console.error("[hellfire-auctions] payment follow-up failed:", a.id, error?.message || error);
    }
  }
}

// After 4 unpaid days: the unpaid sale is counted, and (if the store allows it, once per auction)
// the item is offered to the next bidder. Returns true when the store was already told by email.
async function autoSecondChance(a) {
  const settings = await getShopSettings(a.shop);
  const alreadyOffered = await prisma.auctionNotification.findFirst({ where: { auctionId: a.id, type: "AUTO_OFFERED" }, select: { id: true } });
  if (!settings.autoOfferNext || alreadyOffered || a.isTest) {
    await recordStrike(a.shop, a, a.winnerId, a.winnerDraftOrderId);
    return false; // the store gets the usual "winner hasn't paid" email
  }
  const result = await offerToNextBidder(a.shop, a.id); // counts the unpaid sale itself
  if (result.error) {
    await recordStrike(a.shop, a, a.winnerId, a.winnerDraftOrderId); // nobody to offer it to, but the non-payment still counts
    return false;
  }
  await prisma.auctionNotification.create({ data: { auctionId: a.id, customerId: "__admin__", type: "AUTO_OFFERED", key: "1" } }).catch(() => {});
  const strike = await recordStrike(a.shop, a, a.winnerId, a.winnerDraftOrderId); // unchanged counts (already recorded), for the email
  const after = await prisma.auction.findUnique({ where: { id: a.id }, select: { currentBid: true } });
  await notifyMerchantAutoOffer({ auction: a, price: after?.currentBid ?? a.currentBid, strikes: strike.strikes, blocked: strike.blocked });
  console.log("[hellfire-auctions] unpaid winner: offered to the next bidder automatically", a.id);
  return true;
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

export async function cancelUnpaidSale(shop, auctionId, blockBidder = false) {
  const a = await prisma.auction.findFirst({ where: { id: auctionId, shop } });
  if (!a?.winnerId) return { error: "This auction has no winner." };
  if ((await draftStatus(shop, a.winnerDraftOrderId)) === "COMPLETED") return { error: "The winner already paid, so the sale can't be cancelled here." };
  const previousWinner = a.winnerId;
  await releaseDraftFor(shop, a);
  await prisma.auction.update({
    where: { id: a.id },
    data: { winnerId: null, winnerCheckoutUrl: null, winnerDraftOrderId: null, winnerNotifiedAt: null },
  });
  if (blockBidder) {
    await prisma.blockedBidder.upsert({
      where: { shop_customerId: { shop, customerId: previousWinner } },
      create: { shop, customerId: previousWinner },
      update: {},
    });
    return { success: "Sale cancelled and the bidder is blocked. You can now relist this item or sell it again." };
  }
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
  const strike = await recordStrike(shop, a, a.winnerId, a.winnerDraftOrderId).catch(() => null); // the first winner didn't pay
  await releaseDraftFor(shop, a);
  const updated = await prisma.auction.update({
    where: { id: a.id },
    data: { winnerId: next.bidderId, currentBid: price, winnerDraftOrderId: null, winnerCheckoutUrl: null, winnerNotifiedAt: null },
  });
  const { draftOrderId, checkoutUrl } = await createAndSendWinnerInvoice(updated, next.bidderId, { secondChance: true });
  await prisma.auction.update({ where: { id: a.id }, data: { winnerDraftOrderId: draftOrderId, winnerCheckoutUrl: checkoutUrl } });
  const strikeNote = strike?.blocked ? ` The first winner has ${strike.strikes} unpaid sale${strike.strikes === 1 ? "" : "s"} and was blocked from bidding.` : strike?.strikes ? ` The first winner now has ${strike.strikes} unpaid sale${strike.strikes === 1 ? "" : "s"} on record.` : "";
  return { success: `Second-chance offer sent to the next bidder at ${formatMoney(price, await shopCurrencyCode(shop))}.${strikeNote}` };
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

// One-time: auctions that had bids before bid history existed get one history row per bidder
// (their latest bid). Earlier intermediate bids on those auctions weren't recorded and can't be recovered.
let historyBackfilled = false;
async function backfillBidHistoryOnce() {
  if (historyBackfilled) return;
  historyBackfilled = true;
  if (await repairDone("BID_HISTORY_BACKFILL_V1")) return;
  const auctions = await prisma.auction.findMany({
    where: { bids: { some: {} }, events: { none: {} } },
    select: { id: true },
    take: 500,
  });
  for (const a of auctions) {
    const bids = await prisma.bid.findMany({ where: { auctionId: a.id }, select: { bidderId: true, amount: true, createdAt: true } });
    if (bids.length) {
      await prisma.bidEvent.createMany({
        data: bids.map((b) => ({ auctionId: a.id, bidderId: b.bidderId, amount: Number(b.amount), createdAt: b.createdAt })),
      });
    }
  }
  console.log("[hellfire-auctions] bid history backfilled for", auctions.length, "auctions");
  await markRepairDone("BID_HISTORY_BACKFILL_V1");
}

// ---------- owner watchdog: warns you BEFORE a free-tier limit is hit ----------
// Limits default to Resend's free plan and Neon's free plan. After you upgrade a service, set
// EMAIL_DAILY_LIMIT, EMAIL_MONTHLY_LIMIT and DB_LIMIT_MB in Render so the warnings stay accurate.
let lastWatchdog = 0;
async function ownerWatchdog() {
  if (Date.now() - lastWatchdog < 6 * 3600_000) return;
  lastWatchdog = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  if (await repairDone("OWNER_WATCHDOG_" + day)) return;

  const lim = {
    daily: Number(process.env.EMAIL_DAILY_LIMIT || 100),
    monthly: Number(process.env.EMAIL_MONTHLY_LIMIT || 3000),
    dbMb: Number(process.env.DB_LIMIT_MB || 500),
  };
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600_000);
  const [emails24h, emails30d, dbRows, storeRows] = await Promise.all([
    prisma.auctionNotification.count({ where: { sentAt: { gte: dayAgo }, auctionId: { not: "__system__" }, type: { notIn: ["PAID", "ARCHIVED", "ADMIN_HIDDEN", "EMBED_OFF", "UNPUBLISHED", "STRIKE", "AUTO_OFFERED", "AUTO_RELIST", "AUTO_RELISTED"] } } }),
    prisma.auctionNotification.count({ where: { sentAt: { gte: monthAgo }, auctionId: { not: "__system__" }, type: { notIn: ["PAID", "ARCHIVED", "ADMIN_HIDDEN", "EMBED_OFF", "UNPUBLISHED", "STRIKE", "AUTO_OFFERED", "AUTO_RELIST", "AUTO_RELISTED"] } } }),
    prisma.$queryRaw`SELECT pg_database_size(current_database())::bigint AS bytes`,
    prisma.auction.groupBy({ by: ["shop"], where: { createdAt: { gte: monthAgo } } }),
  ]);
  const dbMb = Math.round(Number(dbRows?.[0]?.bytes || 0) / 1048576);
  const stores = storeRows.length;

  const warnings = [];
  if (emails24h >= lim.daily * 0.7) warnings.push(`Emails sent in the last 24 hours: ${emails24h} (your plan allows about ${lim.daily} a day).`);
  if (emails30d >= lim.monthly * 0.7) warnings.push(`Emails sent in the last 30 days: ${emails30d} (your plan allows about ${lim.monthly} a month).`);
  if (dbMb >= lim.dbMb * 0.7) warnings.push(`Database size: ${dbMb} MB (your plan allows about ${lim.dbMb} MB).`);
  if (warnings.length) {
    await alertOwner("owner-limits-" + day, "You're approaching a usage limit", [
      ...warnings,
      "What to do: upgrade the email plan (Resend Pro is about $20/month for 50,000 emails) or switch to Amazon SES (about $0.10 per 1,000 emails), and upgrade the database plan if the database is the one filling up.",
      "After upgrading, update EMAIL_DAILY_LIMIT, EMAIL_MONTHLY_LIMIT and DB_LIMIT_MB in Render so these warnings stay accurate.",
    ]);
  }

  const month = day.slice(0, 7);
  if (new Date().getUTCDate() === 1 && !(await repairDone("OWNER_REPORT_" + month))) {
    await alertOwner("owner-report-" + month, "Hellfire Auctions monthly owner report", [
      `Active stores (created an auction in the last 30 days): ${stores}`,
      `Emails sent in the last 30 days: ${emails30d} (plan allows about ${lim.monthly})`,
      `Database size: ${dbMb} MB (plan allows about ${lim.dbMb} MB)`,
      "Standing reminders: (1) the free Render server sleeps when idle, so keep UptimeRobot pinging /healthz or move to an always-on plan (about $7/month) before relying on real merchants. (2) Resend's free plan is 100 emails a day and 3,000 a month. (3) Neon's free plan is 0.5 GB and 100 compute-hours a month. (4) Renew hellfireauctions.com at IONOS before it expires. (5) Check your Shopify Partner dashboard for review emails.",
      ...(process.env.OWNER_REMINDERS ? process.env.OWNER_REMINDERS.split(";").map((s) => s.trim()).filter(Boolean) : []),
    ]);
    await markRepairDone("OWNER_REPORT_" + month);
  }
  await markRepairDone("OWNER_WATCHDOG_" + day);
}

async function ensureInvoiceStock(auction) {
  const d = await adminGraphql(
    auction.shop,
    `#graphql
      query InvoiceStock($id: ID!) {
        product(id: $id) { variants(first: 1) { nodes { id inventoryItem { id } } } }
        locations(first: 20) { nodes { id isActive fulfillsOnlineOrders } }
      }
    `,
    { id: auction.productId },
  );
  const variant = d?.product?.variants?.nodes?.[0];
  const nodes = d?.locations?.nodes || [];
  const loc = nodes.find((l) => l.isActive && l.fulfillsOnlineOrders) || nodes.find((l) => l.isActive) || nodes[0];
  if (!variant?.inventoryItem?.id || !loc?.id) return;
  await adminGraphql(
    auction.shop,
    `#graphql
      mutation KeepInvoiceStock($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { message } }
      }
    `,
    {
      input: {
        name: "available",
        reason: "correction",
        quantities: [{ inventoryItemId: variant.inventoryItem.id, locationId: loc.id, quantity: 1, changeFromQuantity: null }],
      },
      idempotencyKey: hfUuid(),
    },
  );
}

// ---------- retention: auction records are deleted 24 months after they end ----------
let lastRetention = 0;
async function retentionSweep() {
  if (Date.now() - lastRetention < 12 * 3600_000) return;
  lastRetention = Date.now();
  const cutoff = new Date(Date.now() - 730 * 24 * 3600_000);
  const old = await prisma.auction.findMany({
    where: { endsAt: { lt: cutoff }, status: { in: ["ENDED", "CANCELLED", "SETTLEMENT_FAILED"] } },
    select: { id: true },
    take: 500,
  });
  if (!old.length) return;
  const ids = old.map((a) => a.id);
  await prisma.auctionNotification.deleteMany({ where: { auctionId: { in: ids } } });
  await prisma.auction.deleteMany({ where: { id: { in: ids } } });
  console.log("[hellfire-auctions] retention: removed", ids.length, "auctions older than 24 months");
}

async function productStillExists(auction) {
  try {
    const d = await adminGraphql(auction.shop, `#graphql
      query ProductExists($id: ID!) { product(id: $id) { id } }`, { id: auction.productId });
    return Boolean(d?.product?.id);
  } catch {
    return true; // can't tell: don't close the auction on a guess
  }
}

// ---------- storefront embed check: is the bidding panel really loading on a live store? ----------
const embedMisses = new Map();
let lastEmbedCheck = 0;
async function checkStorefrontEmbeds() {
  if (Date.now() - lastEmbedCheck < 30 * 60_000) return;
  lastEmbedCheck = Date.now();
  const now = new Date();
  const live = await prisma.auction.findMany({
    where: { startsAt: { lte: now }, endsAt: { gt: now }, isTest: false },
    select: { id: true, shop: true, productId: true, title: true },
    take: 25,
  });
  for (const a of live) {
    try {
      if (await isDevStore(a.shop)) continue; // development stores are password protected
      const d = await adminGraphql(a.shop, `#graphql
        query EmbedCheck($id: ID!) { product(id: $id) { handle } shop { primaryDomain { url } } }`, { id: a.productId });
      const handle = d?.product?.handle;
      const base = d?.shop?.primaryDomain?.url;
      if (!handle || !base) continue;
      const res = await fetch(`${base.replace(/\/$/, "")}/products/${handle}`, {
        headers: { "User-Agent": "HellfireAuctionsHealthCheck/1.0" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      if (/\/password/i.test(res.url) || /storefront_password/.test(html)) continue; // locked store: can't tell
      const row = { auctionId: a.id, customerId: "merchant", type: "EMBED_OFF", key: "1" };
      if (html.includes("hellfire-auction-runtime")) {
        embedMisses.delete(a.id);
        await prisma.auctionNotification.deleteMany({ where: row });
        continue;
      }
      const misses = (embedMisses.get(a.id) || 0) + 1;
      embedMisses.set(a.id, misses);
      if (misses >= 2) {
        const fresh = await prisma.auctionNotification.create({ data: row }).then(() => true).catch(() => false);
        if (fresh) notifyMerchantEmbedOff({ auction: a }).catch(() => {});
      }
    } catch (error) {
      console.error("[hellfire-auctions] embed check failed:", a.id, error?.message || error);
    }
  }
}

// ---------- weekly encrypted backup emailed to the owner ----------
function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
let lastBackupCheck = 0;
async function weeklyBackup() {
  if (Date.now() - lastBackupCheck < 6 * 3600_000) return;
  lastBackupCheck = Date.now();
  if (!process.env.RESEND_API_KEY) return;
  const key = "OWNER_BACKUP_" + weekKey();
  if (await repairDone(key)) return;
  const [auctions, bids, events, watches, plans] = await Promise.all([
    prisma.auction.findMany(),
    prisma.bid.findMany(),
    prisma.bidEvent.findMany(),
    prisma.watch.findMany(),
    prisma.shopPlan.findMany(),
  ]);
  const counts = `${auctions.length} auctions, ${bids.length} bids, ${events.length} history rows, ${watches.length} watches`;
  const json = JSON.stringify({ exportedAt: new Date().toISOString(), counts, auctions, bids, events, watches, plans });
  if (Buffer.byteLength(json) > 15 * 1024 * 1024) {
    await alertOwner("backup-too-big", "The weekly backup is too large to email", ["The database export is over 15 MB. Time to move backups to storage (or a paid database plan with longer history)."]);
    return;
  }
  if (await emailEncryptedBackup({ json, counts })) {
    console.log("[hellfire-auctions] weekly backup emailed:", counts);
    await markRepairDone(key);
  }
}

// ---------- combined invoices ----------
async function variantLine(shop, auction) {
  const d = await adminGraphql(shop, `#graphql
    query CombineVariant($id: ID!) { shop { currencyCode } product(id: $id) { variants(first: 1) { nodes { id } } } }`, { id: auction.productId });
  const variantId = d?.product?.variants?.nodes?.[0]?.id;
  if (!variantId) return null;
  return {
    variantId,
    quantity: 1,
    priceOverride: { amount: Number(auction.currentBid).toFixed(2), currencyCode: d?.shop?.currencyCode || "USD" },
  };
}

// An item leaves a shared invoice: keep the others payable (or delete the invoice if it was the only one).
export async function releaseDraftFor(shop, a) {
  if (!a?.winnerDraftOrderId) return;
  const siblings = await prisma.auction.findMany({
    where: { shop, winnerDraftOrderId: a.winnerDraftOrderId, id: { not: a.id } },
    select: { id: true, productId: true, currentBid: true },
  });
  if (!siblings.length) {
    await deleteDraft(shop, a.winnerDraftOrderId);
    return;
  }
  const lines = [];
  for (const s of siblings) {
    const line = await variantLine(shop, s);
    if (line) lines.push(line);
  }
  if (!lines.length) return;
  await adminGraphql(shop, `#graphql
    mutation TrimSharedDraft($id: ID!, $input: DraftOrderInput!) {
      draftOrderUpdate(id: $id, input: $input) { draftOrder { id } userErrors { message } }
    }`, { id: a.winnerDraftOrderId, input: { lineItems: lines } });
}

const combining = new Set();

// Merge ALL of one buyer's unpaid wins in a store into a single invoice (one shipping charge).
export async function combineWinnerInvoices(shop, customerId, { notifyBuyer = false } = {}) {
  const lockKey = `${shop}|${customerId}`;
  if (combining.has(lockKey)) return { error: "Your combined invoice is already being prepared. Please wait a moment." };
  combining.add(lockKey);
  try {
    const wins = await prisma.auction.findMany({
      where: { shop, winnerId: String(customerId), status: "ENDED", winnerDraftOrderId: { not: null } },
      orderBy: { endsAt: "asc" },
      take: 25,
    });
    if (wins.length < 2) return { error: "There aren't two or more unpaid wins to combine." };
    const draftIds = [...new Set(wins.map((w) => w.winnerDraftOrderId))];
    const st = await adminGraphql(shop, `#graphql
      query DraftStatuses($ids: [ID!]!) { nodes(ids: $ids) { ... on DraftOrder { id status } } }`, { ids: draftIds });
    const statusById = new Map((st?.nodes || []).filter(Boolean).map((n) => [n.id, n.status]));
    const unpaid = wins.filter((w) => ["OPEN", "INVOICE_SENT"].includes(statusById.get(w.winnerDraftOrderId)));
    if (unpaid.length < 2) return { error: "There aren't two or more unpaid wins to combine." };
    const oldDrafts = [...new Set(unpaid.map((w) => w.winnerDraftOrderId))];
    if (oldDrafts.length === 1) return { url: unpaid[0].winnerCheckoutUrl, count: unpaid.length, already: true };

    const lines = [];
    for (const w of unpaid) {
      await ensureInvoiceStock(w).catch((error) => console.error("[hellfire-auctions] stock re-check failed:", error?.message || error));
      const line = await variantLine(shop, w);
      if (!line) return { error: `"${w.title}" can no longer be found in the store, so these wins can't be combined. Please contact the seller.` };
      lines.push(line);
    }
    const total = unpaid.reduce((s, w) => s + Number(w.currentBid || 0), 0);
    const customerGid = String(customerId).startsWith("gid://") ? String(customerId) : `gid://shopify/Customer/${customerId}`;
    const created = await adminGraphql(shop, `#graphql
      mutation CreateCombinedDraft($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { field message } }
      }`, {
      input: {
        purchasingEntity: { customerId: customerGid },
        note: `Hellfire Auctions winner: ${unpaid.length} combined items`,
        tags: ["Hellfire Auction", "Combined"],
        lineItems: lines,
        customAttributes: [
          { key: "Auction IDs", value: unpaid.map((w) => w.id).join(", ") },
          { key: "Winning bids", value: total.toFixed(2) },
        ],
      },
    });
    throwUserErrors(created?.draftOrderCreate?.userErrors);
    const draft = created?.draftOrderCreate?.draftOrder;
    if (!draft?.id || !draft?.invoiceUrl) return { error: "Shopify couldn't create the combined invoice. Please try again." };

    // Point every item at the new invoice FIRST, then retire the old ones (never leaves an item without an invoice).
    await prisma.auction.updateMany({
      where: { id: { in: unpaid.map((w) => w.id) } },
      data: { winnerDraftOrderId: draft.id, winnerCheckoutUrl: draft.invoiceUrl, winnerNotifiedAt: new Date() },
    });
    for (const old of oldDrafts) await deleteDraft(shop, old);
    console.log("[hellfire-auctions] combined invoice created", JSON.stringify({ shop, customerId, items: unpaid.length }));
    if (notifyBuyer) {
      await notifyCombinedInvoice({ shop, customerId, count: unpaid.length, total, url: draft.invoiceUrl }).catch((error) =>
        console.error("[hellfire-auctions] combined invoice email failed:", error?.message || error),
      );
    }
    return { url: draft.invoiceUrl, count: unpaid.length, total };
  } catch (error) {
    console.error("[hellfire-auctions] combine failed:", error?.message || error);
    return { error: "Couldn't combine the invoices. Please try again, or pay each one separately." };
  } finally {
    combining.delete(lockKey);
  }
}

// Joins a new win onto the buyer's unpaid COMBINED invoice (two or more items already on one invoice they chose).
// Anything unexpected falls back to a normal separate invoice, so a win is never left without one.
async function tryJoinCombinedInvoice(auction, winnerId) {
  const shop = auction.shop;
  const lockKey = `${shop}|${winnerId}`;
  if (combining.has(lockKey)) return null;
  combining.add(lockKey);
  try {
    const others = await prisma.auction.findMany({
      where: { shop, winnerId: String(winnerId), status: "ENDED", winnerDraftOrderId: { not: null }, id: { not: auction.id } },
      select: { id: true, title: true, productId: true, currentBid: true, endsAt: true, winnerDraftOrderId: true, winnerCheckoutUrl: true },
    });
    const byDraft = new Map();
    for (const o of others) {
      if (!byDraft.has(o.winnerDraftOrderId)) byDraft.set(o.winnerDraftOrderId, []);
      byDraft.get(o.winnerDraftOrderId).push(o);
    }
    // Prefer the invoice with the most items. Invoices older than 72 hours aren't reopened, so one never grows forever.
    for (const [draftId, items] of [...byDraft.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const oldest = Math.min(...items.map((i) => new Date(i.endsAt).getTime()));
      if (Date.now() - oldest > 72 * 3600_000) continue;
      if (!["OPEN", "INVOICE_SENT"].includes(await draftStatus(shop, draftId))) continue;
      const everything = [...items, auction];
      const lines = [];
      for (const item of everything) {
        const line = await variantLine(shop, item);
        if (!line) return null;
        lines.push(line);
      }
      const r = await adminGraphql(shop, `#graphql
        mutation JoinDraft($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) { draftOrder { id } userErrors { message } }
        }`, { id: draftId, input: { lineItems: lines } });
      if ((r?.draftOrderUpdate?.userErrors || []).length || !r?.draftOrderUpdate?.draftOrder?.id) return null;
      const checkoutUrl = items[0].winnerCheckoutUrl;
      const total = everything.reduce((s, x) => s + Number(x.currentBid || 0), 0);
      await prisma.auction.updateMany({ where: { winnerDraftOrderId: draftId }, data: { winnerNotifiedAt: new Date() } });
      await prisma.auction.update({
        where: { id: auction.id },
        data: { winnerDraftOrderId: draftId, winnerCheckoutUrl: checkoutUrl, winnerNotifiedAt: new Date() },
      });
      console.log("[hellfire-auctions] win joined the buyer's combined invoice", JSON.stringify({ shop, winnerId, items: everything.length }));
      notifyJoinedInvoice({ shop, customerId: winnerId, title: auction.title, count: everything.length, total, url: checkoutUrl }).catch((error) =>
        console.error("[hellfire-auctions] joined-invoice email failed:", error?.message || error),
      );
      return { draftOrderId: draftId, checkoutUrl };
    }
    return null;
  } catch (error) {
    console.error("[hellfire-auctions] join failed, issuing a separate invoice:", error?.message || error);
    return null;
  } finally {
    combining.delete(lockKey);
  }
}

// ---------- paid invoices: archive the product from the storefront, remember when it was paid ----------
let lastPaidSweep = 0;
async function paymentSweep(minGapMs = 9 * 60_000) {
  if (Date.now() - lastPaidSweep < minGapMs) return;
  lastPaidSweep = Date.now();
  const rows = await prisma.auction.findMany({
    where: {
      status: "ENDED",
      winnerId: { not: null },
      winnerDraftOrderId: { not: null },
      winnerNotifiedAt: { gte: new Date(Date.now() - 14 * 24 * 3600_000) },
    },
    take: 300,
  });
  if (!rows.length) return;
  const marks = await prisma.auctionNotification.findMany({
    where: { auctionId: { in: rows.map((r) => r.id) }, type: { in: ["PAID", "ARCHIVED"] } },
    select: { auctionId: true, type: true },
  });
  const archived = new Set(marks.filter((m) => m.type === "ARCHIVED").map((m) => m.auctionId));
  const paidMarked = new Set(marks.filter((m) => m.type === "PAID").map((m) => m.auctionId));
  const byShop = new Map();
  for (const r of rows.filter((x) => !archived.has(x.id))) {
    if (!byShop.has(r.shop)) byShop.set(r.shop, []);
    byShop.get(r.shop).push(r);
  }
  for (const [shop, list] of byShop) {
    try {
      const draftIds = [...new Set(list.map((r) => r.winnerDraftOrderId))];
      const statusById = new Map();
      for (let i = 0; i < draftIds.length; i += 50) {
        const d = await adminGraphql(shop, `#graphql
          query PaidStatuses($ids: [ID!]!) { nodes(ids: $ids) { ... on DraftOrder { id status } } }`, { ids: draftIds.slice(i, i + 50) });
        for (const n of d?.nodes || []) if (n?.id) statusById.set(n.id, n.status);
      }
      const tally = {};
      for (const r of list) {
        const s = statusById.get(r.winnerDraftOrderId) || "NOT_FOUND";
        tally[s] = (tally[s] || 0) + 1;
      }
      console.log("[hellfire-auctions] payment sweep:", shop, JSON.stringify(tally));
      for (const r of list) {
        if (statusById.get(r.winnerDraftOrderId) !== "COMPLETED") continue;
        if (!paidMarked.has(r.id)) {
          await prisma.auctionNotification.create({ data: { auctionId: r.id, customerId: String(r.winnerId), type: "PAID", key: "1" } }).catch(() => {});
        }
        try {
          const res = await adminGraphql(shop, `#graphql
            mutation ArchivePaid($product: ProductUpdateInput!) {
              productUpdate(product: $product) { product { id } userErrors { message } }
            }`, { product: { id: r.productId, status: "ARCHIVED" } });
          if ((res?.productUpdate?.userErrors || []).length) throw new Error(res.productUpdate.userErrors.map((e) => e.message).join(", "));
          await prisma.auctionNotification.create({ data: { auctionId: r.id, customerId: String(r.winnerId), type: "ARCHIVED", key: "1" } }).catch(() => {});
          console.log("[hellfire-auctions] paid item archived from the storefront", r.id);
        } catch (error) {
          console.error("[hellfire-auctions] archive failed:", r.id, error?.message || error);
        }
      }
    } catch (error) {
      console.error("[hellfire-auctions] payment sweep failed for", shop, error?.message || error);
    }
  }
}

// Also run when a merchant opens the app or a customer opens My Auctions (at most every 45 seconds),
// so a paid item is archived within a minute of the buyer coming back to the store.
export async function runPaymentSweep(minGapMs = 45_000) {
  return paymentSweep(minGapMs);
}

// ---------- unsold auctions: take the product off the Online Store (any theme, anywhere on the store) ----------
// An auction that ended with no winner (no bids, reserve not met, ended early, or a test on a live store) is
// unpublished 10 minutes after it ends. Relisting republishes it. Sold items are archived once paid instead.
let lastUnsoldSweep = 0;
async function unsoldSweep(minGapMs = 9 * 60_000) {
  if (Date.now() - lastUnsoldSweep < minGapMs) return;
  lastUnsoldSweep = Date.now();
  const rows = await prisma.auction.findMany({
    where: {
      status: { in: ["ENDED", "CANCELLED"] },
      winnerId: null,
      endsAt: { lt: new Date(Date.now() - 10 * 60_000), gt: new Date(Date.now() - 7 * 24 * 3600_000) },
    },
    orderBy: { endsAt: "desc" },
    take: 200,
  });
  if (!rows.length) return;
  const marks = await prisma.auctionNotification.findMany({
    where: { auctionId: { in: rows.map((r) => r.id) }, type: "UNPUBLISHED" },
    select: { auctionId: true },
  });
  const handled = new Set(marks.map((m) => m.auctionId));
  const publicationByShop = new Map();
  for (const r of rows.filter((x) => !handled.has(x.id))) {
    try {
      // If the item was relisted (a newer auction exists for the same product), leave it on sale.
      const newer = await prisma.auction.count({ where: { shop: r.shop, productId: r.productId, createdAt: { gt: r.createdAt } } });
      if (newer) {
        await prisma.auctionNotification.create({ data: { auctionId: r.id, customerId: "__admin__", type: "UNPUBLISHED", key: "skipped" } }).catch(() => {});
        continue;
      }
      if (!publicationByShop.has(r.shop)) {
        const d = await adminGraphql(r.shop, `#graphql
          query OnlineStorePublication { publications(first: 50) { nodes { id name } } }`);
        publicationByShop.set(r.shop, d?.publications?.nodes?.find((p) => p.name === "Online Store")?.id || null);
      }
      const publicationId = publicationByShop.get(r.shop);
      if (!publicationId) continue;
      const res = await adminGraphql(r.shop, `#graphql
        mutation UnpublishUnsold($id: ID!, $input: [PublicationInput!]!) {
          publishableUnpublish(id: $id, input: $input) { userErrors { message } }
        }`, { id: r.productId, input: [{ publicationId }] });
      const errors = res?.publishableUnpublish?.userErrors || [];
      if (errors.length) throw new Error(errors.map((e) => e.message).join(", "));
      await prisma.auctionNotification.create({ data: { auctionId: r.id, customerId: "__admin__", type: "UNPUBLISHED", key: "1" } }).catch(() => {});
      console.log("[hellfire-auctions] unsold auction taken off the store", r.id);
    } catch (error) {
      console.error("[hellfire-auctions] unpublish failed:", r.id, error?.message || error);
    }
  }
}

// ---------- automatic relist: an unsold item goes live again for the same length ----------
async function putProductBackOnSale(shop, productId) {
  const data = await adminGraphql(shop, `#graphql
    query LiveAuctionsAgain { collections(first: 100, query: "title:'Live Auctions'") { nodes { id title } } }`);
  const collection = data?.collections?.nodes?.find((c) => c.title === "Live Auctions");
  if (collection) {
    const added = await adminGraphql(shop, `#graphql
      mutation AddBackToLive($id: ID!, $productIds: [ID!]!) { collectionAddProducts(id: $id, productIds: $productIds) { userErrors { message } } }`,
    { id: collection.id, productIds: [productId] });
    const addErrors = added?.collectionAddProducts?.userErrors || [];
    if (addErrors.length) console.error("[hellfire-auctions] relist: collection note:", addErrors.map((e) => e.message).join(", "));
  }
  const active = await adminGraphql(shop, `#graphql
    mutation ReactivateProduct($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { message } } }`,
  { product: { id: productId, status: "ACTIVE" } });
  throwUserErrors(active?.productUpdate?.userErrors);
  const pubs = await adminGraphql(shop, `#graphql
    query OnlineStoreAgain { publications(first: 50) { nodes { id name } } }`);
  const publicationId = pubs?.publications?.nodes?.find((p) => p.name === "Online Store")?.id;
  if (publicationId) {
    const published = await adminGraphql(shop, `#graphql
      mutation RepublishProduct($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
    { id: productId, input: [{ publicationId }] });
    const pubErrors = published?.publishablePublish?.userErrors || [];
    if (pubErrors.length) console.error("[hellfire-auctions] relist: publish note:", pubErrors.map((e) => e.message).join(", "));
  }
}

let lastAutoRelist = 0;
async function autoRelistSweep(minGapMs = 30_000) {
  if (Date.now() - lastAutoRelist < minGapMs) return;
  lastAutoRelist = Date.now();
  const nowMs = Date.now();
  const rows = await prisma.auction.findMany({
    where: { status: "ENDED", winnerId: null, isTest: false, endsAt: { lt: new Date(nowMs - 60_000), gt: new Date(nowMs - 24 * 3600_000) } },
    orderBy: { endsAt: "asc" },
    take: 50,
  });
  if (!rows.length) return;
  const marks = await prisma.auctionNotification.findMany({
    where: { auctionId: { in: rows.map((r) => r.id) }, type: { in: ["AUTO_RELIST", "AUTO_RELISTED"] } },
    select: { auctionId: true, type: true, key: true },
  });
  const wanted = new Map();
  const finished = new Set();
  for (const m of marks) {
    if (m.type === "AUTO_RELIST") wanted.set(m.auctionId, Number(m.key) || 0);
    else finished.add(m.auctionId);
  }
  for (const a of rows) {
    const left = wanted.get(a.id) || 0;
    if (left <= 0 || finished.has(a.id)) continue;
    const settle = (key) => prisma.auctionNotification.create({ data: { auctionId: a.id, customerId: "__admin__", type: "AUTO_RELISTED", key } }).catch(() => {});
    try {
      const newer = await prisma.auction.count({ where: { shop: a.shop, productId: a.productId, createdAt: { gt: a.createdAt } } });
      if (newer) {
        await settle("already"); // relisted by hand in the meantime
        continue;
      }
      const quota = await canCreateAuction(a.shop);
      if (!quota.allowed) {
        await settle("limit");
        console.log("[hellfire-auctions] automatic relist skipped: monthly limit reached", a.id);
        continue;
      }
      await putProductBackOnSale(a.shop, a.productId);
      const length = Math.max(60 * 60_000, a.endsAt.getTime() - a.startsAt.getTime());
      const start = new Date();
      const created = await prisma.auction.create({
        data: {
          shop: a.shop,
          productId: a.productId,
          title: a.title,
          description: a.description,
          imageUrl: a.imageUrl,
          startingBid: a.startingBid,
          currentBid: a.startingBid,
          reservePrice: a.reservePrice,
        buyNowPrice: a.buyNowPrice,
          autoExtend: a.autoExtend,
          isTest: false,
          startsAt: start,
          endsAt: new Date(start.getTime() + length),
          status: "LIVE",
        },
      });
      await settle("1");
      if (left - 1 > 0) {
        await prisma.auctionNotification.create({ data: { auctionId: created.id, customerId: "__admin__", type: "AUTO_RELIST", key: String(left - 1) } }).catch(() => {});
      }
      console.log("[hellfire-auctions] unsold auction relisted automatically", a.id, "->", created.id);
    } catch (error) {
      console.error("[hellfire-auctions] automatic relist failed:", a.id, error?.message || error);
    }
  }
}

async function tick() {
  await winnerCatchUpOnce().catch((error) => console.error("[hellfire-auctions] winner catch-up error:", error?.message || error));
  await backfillBidHistoryOnce().catch((error) => console.error("[hellfire-auctions] history backfill error:", error?.message || error));
  await ownerWatchdog().catch((error) => console.error("[hellfire-auctions] owner watchdog error:", error?.message || error));
  await retentionSweep().catch((error) => console.error("[hellfire-auctions] retention error:", error?.message || error));
  await checkStorefrontEmbeds().catch((error) => console.error("[hellfire-auctions] embed check error:", error?.message || error));
  await weeklyBackup().catch((error) => console.error("[hellfire-auctions] weekly backup error:", error?.message || error));
  await lockExistingAuctionInventory().catch((error) => console.error("[hellfire-auctions] stock lock error:", error?.message || error));
  await restoreVariantDrafts().catch((error) => console.error("[hellfire-auctions] draft restore error:", error?.message || error));
  await paymentFollowUps().catch((error) => console.error("[hellfire-auctions] payment follow-ups error:", error?.message || error));
  await paymentSweep().catch((error) => console.error("[hellfire-auctions] payment sweep error:", error?.message || error));
  await selfTestIfDue((subject, lines) => alertOwner("self-test", subject, lines)).catch((error) => console.error("[hellfire-auctions] self-test error:", error?.message || error));
  await orphanSweepIfDue().catch((error) => console.error("[hellfire-auctions] leftover-product sweep error:", error?.message || error));
  await autoRelistSweep().catch((error) => console.error("[hellfire-auctions] auto-relist error:", error?.message || error));
  await unsoldSweep().catch((error) => console.error("[hellfire-auctions] unsold sweep error:", error?.message || error));
  await sendWatcherReminders().catch((error) => console.error("[hellfire-auctions] watcher reminders error:", error?.message || error));
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
      notifyWatchersStarted({ auction }).catch(() => {});
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
      // The store owner is told too: once now, and once more if the app finally gives up.
      const gaveUp = Date.now() - new Date(auction.endsAt).getTime() > GIVE_UP_AFTER_MS;
      notifyMerchantSettleFailed({ auction, error: String(error?.message || error), final: gaveUp }).catch(() => {});
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
  const waiting = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM "Auction" a
    WHERE a."status" = 'ENDED' AND a."winnerId" IS NOT NULL
      AND a."winnerNotifiedAt" >= now() - interval '5 days'
      AND NOT EXISTS (SELECT 1 FROM "AuctionNotification" n WHERE n."auctionId" = a."id" AND n."type" = 'ARCHIVED')`;
  if (Number(waiting?.[0]?.n || 0) > 0) waits.push(10 * 60_000);
  const relistPending = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM "Auction" a
    WHERE a."status" = 'ENDED' AND a."winnerId" IS NULL AND a."isTest" = false
      AND a."endsAt" > now() - interval '24 hours'
      AND EXISTS (SELECT 1 FROM "AuctionNotification" m WHERE m."auctionId" = a."id" AND m."type" = 'AUTO_RELIST')
      AND NOT EXISTS (SELECT 1 FROM "AuctionNotification" d WHERE d."auctionId" = a."id" AND d."type" = 'AUTO_RELISTED')`;
  if (Number(relistPending?.[0]?.n || 0) > 0) waits.push(60_000);
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
  globalThis.__HF_LAST_TICK__ = Date.now();
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
  selfTestAfterBoot((subject, lines) => alertOwner("self-test", subject, lines));
  orphanSweepAfterBoot();
  startDropsFollowUp();
  runScheduledTick().catch((error) =>
    console.error("[hellfire-auctions] initial settlement failed:", error),
  );
}
