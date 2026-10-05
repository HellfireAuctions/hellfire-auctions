import crypto from "node:crypto";
import { useActionData, useLoaderData, useRevalidator, Form } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveProxyBids } from "../bidding.server";
import { canCreateAuction, getShopPlan } from "../plans.server";
import { wakeWorker, offerToNextBidder, remindWinnerNow, cancelUnpaidSale, combineWinnerInvoices, releaseDraftFor, runPaymentSweep } from "../auction-worker.server";
import { getShopSettings, saveShopSettings } from "../settings.server";
import { BIDDER_RULES } from "../bidder-rules";
import { memoDelete } from "../memo.server";
import { parseStoreLocal, staggeredEnds, validateEvent } from "../event-schedule";
import BulkImport from "../bulk-import";

const DURATION_OPTIONS = [
  { value: "1", label: "24 Hours" },
  { value: "3", label: "3 Days" },
  { value: "5", label: "5 Days" },
  { value: "7", label: "7 Days" },
  { value: "14", label: "14 Days" },
  { value: "30", label: "30 Days" },
  { value: "m10", label: "Test \u2014 10 minutes (no sale)" },
  { value: "m5", label: "Test \u2014 5 minutes (no sale)" },
];

// "7" = 7 days, "m5" = 5 minutes (test auctions).
function durationMs(value) {
  const v = String(value || "");
  return v.startsWith("m") ? Number(v.slice(1)) * 60 * 1000 : Number(v) * 24 * 60 * 60 * 1000;
}

function isDurationOption(value) {
  return DURATION_OPTIONS.some((o) => o.value === String(value));
}

const DEFAULT_TZ = "America/New_York";
const storeEmailCache = new Map(); // shop -> { at, emails }

// The store's own time zone from Shopify (Settings > General). Falls back to Eastern.
async function shopTimezone(admin) {
  try {
    const response = await admin.graphql(`#graphql
      query ShopTimezone { shop { ianaTimezone } }`);
    const json = await response.json();
    const tz = json?.data?.shop?.ianaTimezone;
    if (tz) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }); // validate
      return tz;
    }
  } catch (error) {
    console.error("[hellfire-auctions] shop time zone lookup failed:", error?.message || error);
  }
  return DEFAULT_TZ;
}

// The store's own name (Settings > General), used as the product vendor.
async function shopDisplayName(admin) {
  try {
    const response = await admin.graphql(`#graphql
      query ShopName { shop { name } }`);
    const json = await response.json();
    return json?.data?.shop?.name || "Auction";
  } catch {
    return "Auction";
  }
}

function easternOffset(date, tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  }).formatToParts(date);

  const value =
    parts.find((part) => part.type === "timeZoneName")?.value || "GMT-4";

  const match = value.match(/GMT([+-])(\d+)(?::(\d+))?/);

  if (!match) return -4 * 60;

  const sign = match[1] === "-" ? -1 : 1;

  return sign * (
    Number(match[2]) * 60 +
    Number(match[3] || 0)
  );
}

function easternLocalToUtc(dateString, hour, minute, ampm, tz = DEFAULT_TZ) {
  let h = Number(hour);

  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;

  const naive = new Date(
    `${dateString}T${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
  );

  // Two passes so the offset is correct on daylight-saving change days.
  const firstGuess = new Date(naive.getTime() - easternOffset(naive, tz) * 60 * 1000);
  const offsetMinutes = easternOffset(firstGuess, tz);

  return new Date(
    naive.getTime() - offsetMinutes * 60 * 1000,
  );
}

function formatEastern(date, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function easternToday(tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type) =>
    parts.find((part) => part.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function getEasternParts(dateValue, tz = DEFAULT_TZ) {
  const date = new Date(dateValue);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const get = (type) =>
    parts.find((part) => part.type === type)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: get("hour"),
    minute: get("minute"),
    ampm: get("dayPeriod"),
  };
}

async function uploadImage(admin, imageFile) {
  const stagedResponse = await admin.graphql(
    `#graphql
      mutation StagedUpload($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            message
          }
        }
      }
    `,
    {
      variables: {
        input: [
          {
            filename: imageFile.name,
            mimeType: imageFile.type,
            httpMethod: "POST",
            resource: "PRODUCT_IMAGE",
          },
        ],
      },
    },
  );

  const stagedJson = await stagedResponse.json();
  const result = stagedJson?.data?.stagedUploadsCreate;

  if (result?.userErrors?.length) {
    throw new Error(
      result.userErrors.map((error) => error.message).join(", "),
    );
  }

  const target = result?.stagedTargets?.[0];

  if (!target) {
    throw new Error("Shopify did not provide an image upload target.");
  }

  const uploadForm = new FormData();

  for (const parameter of target.parameters) {
    uploadForm.append(parameter.name, parameter.value);
  }

  uploadForm.append("file", imageFile, imageFile.name);

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: uploadForm,
  });

  if (!uploadResponse.ok) {
    throw new Error("Shopify image upload failed.");
  }

  return target.resourceUrl;
}

async function getProductImage(admin, productId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await admin.graphql(
      `#graphql
        query AuctionProductImage($id: ID!) {
          product(id: $id) {
            media(first: 10) {
              nodes {
                id
                mediaContentType
                ... on MediaImage {
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          id: productId,
        },
      },
    );

    const json = await response.json();

    const media =
      json?.data?.product?.media?.nodes || [];

    const image = media.find(
      (item) => item?.image?.url,
    );

    if (image?.image?.url) {
      return {
        url: image.image.url,
        mediaIds: media
          .filter((item) => item.mediaContentType === "IMAGE")
          .map((item) => item.id),
      };
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 750),
    );
  }

  return {
    url: null,
    mediaIds: [],
  };
}


const WEIGHT_LABELS = { OUNCES: "oz", POUNDS: "lb", GRAMS: "g", KILOGRAMS: "kg" };

// Optional shipping weight, so the store's weight-based or carrier-calculated rates can price the winner's shipping.
async function setAuctionWeight(admin, productId, value, unit) {
  const r = await admin.graphql(
    `#graphql
      query WeightVariant($id: ID!) { product(id: $id) { variants(first: 1) { nodes { inventoryItem { id } } } } }`,
    { variables: { id: productId } },
  );
  const itemId = (await r.json())?.data?.product?.variants?.nodes?.[0]?.inventoryItem?.id;
  if (!itemId) return;
  const weightResult = await admin.graphql(
    `#graphql
      mutation SetWeight($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { message } }
      }`,
    { variables: { id: itemId, input: { measurement: { weight: { value, unit } } } } },
  );
  const weightErrors = (await weightResult.json())?.data?.inventoryItemUpdate?.userErrors || [];
  if (weightErrors.length) throw new Error(weightErrors.map((e) => e.message).join(", "));
}

async function ensureAuctionVariantAvailable(admin, productId) {
  const productResponse = await admin.graphql(
    `#graphql
      query AuctionVariant($id: ID!) {
        product(id: $id) {
          variants(first: 1) {
            nodes {
              id
              inventoryItem {
                id
              }
            }
          }
        }
        locations(first: 1) {
          nodes {
            id
          }
        }
      }
    `,
    { variables: { id: productId } },
  );

  const json = await productResponse.json();
  const variant = json?.data?.product?.variants?.nodes?.[0];
  let locationId = json?.data?.locations?.nodes?.[0]?.id;
  try {
    const lr = await admin.graphql(`#graphql
      query OnlineLocations { locations(first: 20) { nodes { id isActive fulfillsOnlineOrders } } }`);
    const nodes = (await lr.json())?.data?.locations?.nodes || [];
    const best = nodes.find((l) => l.isActive && l.fulfillsOnlineOrders) || nodes.find((l) => l.isActive);
    if (best?.id) locationId = best.id;
  } catch {
    // keep the first location
  }

  if (!variant?.inventoryItem?.id || !locationId) {
    throw new Error("Shopify could not prepare the auction product inventory.");
  }

  try {
    await admin.graphql(
      `#graphql
        mutation DenyOversell($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { message }
          }
        }
      `,
      { variables: { productId, variants: [{ id: variant.id, inventoryPolicy: "DENY", price: "99999.00" }] } },
    );
  } catch (error) {
    console.error("[admin] could not set stock policy:", error?.message || error);
  }

  const trackingResponse = await admin.graphql(
    `#graphql
      mutation TrackAuctionInventory($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          inventoryItem { id tracked }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        id: variant.inventoryItem.id,
        input: { tracked: true },
      },
    },
  );

  const trackingJson = await trackingResponse.json();
  const trackingErrors = trackingJson?.data?.inventoryItemUpdate?.userErrors || [];
  if (trackingErrors.length) {
    throw new Error(trackingErrors.map((error) => error.message).join(", "));
  }

  const response = await admin.graphql(
    `#graphql
      mutation SetAuctionInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryAdjustmentGroup {
            changes {
              name
              quantityAfterChange
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: {
          name: "available",
          reason: "correction",
          quantities: [{
            inventoryItemId: variant.inventoryItem.id,
            locationId,
            quantity: 1,
            changeFromQuantity: null,
          }],
        },
        idempotencyKey: crypto.randomUUID(),
      },
    },
  );

  const result = await response.json();
  const errors = result?.data?.inventorySetQuantities?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(", "));
  }
}


const MY_AUCTIONS_URL = "/apps/hellfire-auctions/my-auctions";
const MENU_ITEM_FIELDS = "id title type url resourceId tags";

// Finds the store's main menu and whether it already links to My Auctions.
async function getMainMenu(admin) {
  const response = await admin.graphql(`#graphql
    query MainMenu {
      menus(first: 25) {
        nodes {
          id handle title
          items { ${MENU_ITEM_FIELDS} items { ${MENU_ITEM_FIELDS} items { ${MENU_ITEM_FIELDS} } } }
        }
      }
    }`);
  const json = await response.json();
  const menus = json?.data?.menus?.nodes || [];
  const menu = menus.find((m) => m.handle === "main-menu") || menus[0] || null;
  if (!menu) return { menu: null, hasLink: false };
  const has = (items) => (items || []).some((i) => (i.url || "").includes(MY_AUCTIONS_URL) || has(i.items));
  return { menu, hasLink: has(menu.items) };
}

// Rebuilds the item list exactly as it is (menuUpdate replaces all items), then adds ours at the end.
function toMenuInput(items) {
  return (items || []).map((i) => ({
    id: i.id,
    title: i.title,
    type: i.type,
    ...(i.url ? { url: i.url } : {}),
    ...(i.resourceId ? { resourceId: i.resourceId } : {}),
    ...(i.tags?.length ? { tags: i.tags } : {}),
    items: toMenuInput(i.items),
  }));
}

async function addMyAuctionsToMenu(admin) {
  const { menu, hasLink } = await getMainMenu(admin);
  if (!menu) return { error: "Your store doesn't have a navigation menu yet." };
  if (hasLink) return { success: "\u201CMy Auctions\u201D is already in your store menu." };
  const items = [...toMenuInput(menu.items), { title: "My Auctions", type: "HTTP", url: MY_AUCTIONS_URL, items: [] }];
  const response = await admin.graphql(
    `#graphql
      mutation AddMyAuctions($id: ID!, $title: String!, $handle: String, $items: [MenuItemUpdateInput!]!) {
        menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
          menu { id }
          userErrors { field message }
        }
      }`,
    { variables: { id: menu.id, title: menu.title, handle: menu.handle, items } },
  );
  const json = await response.json();
  const errors = json?.data?.menuUpdate?.userErrors || [];
  if (errors.length) return { error: "Couldn't update your menu: " + errors.map((e) => e.message).join(", ") };
  return { success: "Added \u201CMy Auctions\u201D to your store menu. Customers can now find every auction they've bid on." };
}

async function ensureLiveAuctionsCollection(admin) {
  const response = await admin.graphql(
    `#graphql
      query LiveAuctionsCollection {
        collections(first: 100) {
          nodes {
            id
            title
            ruleSet {
              rules {
                column
                relation
                condition
              }
            }
          }
        }
      }
    `,
  );

  const json = await response.json();
  const existing = json?.data?.collections?.nodes?.find(
    (collection) => collection.title === "Live Auctions",
  );

  if (existing) {
    if (existing.ruleSet) {
      throw new Error(
        'The "Live Auctions" collection is rule-based. Please convert it to a manual collection so the auction app can assign products automatically.',
      );
    }
    return existing;
  }

  const createResponse = await admin.graphql(
    `#graphql
      mutation CreateLiveAuctionsCollection($input: CollectionInput!) {
        collectionCreate(input: $input) {
          collection {
            id
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: {
          title: "Live Auctions",
          descriptionHtml: "<p>Active Hellfire Auctions</p>",
        },
      },
    },
  );

  const createJson = await createResponse.json();
  const result = createJson?.data?.collectionCreate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  if (!result?.collection?.id) {
    throw new Error('Shopify could not create the "Live Auctions" collection.');
  }

  return result.collection;
}

async function ensureAuctionStorefront(admin, productId) {
  const publicationsResponse = await admin.graphql(
    `#graphql
      query AuctionPublications {
        publications(first: 50) {
          nodes {
            id
            name
          }
        }
      }
    `,
  );

  const publicationsJson =
    await publicationsResponse.json();

  const onlineStore =
    publicationsJson?.data?.publications?.nodes?.find(
      (publication) =>
        publication.name === "Online Store",
    );

  if (!onlineStore) {
    throw new Error(
      'The Shopify "Online Store" publication could not be found.',
    );
  }

  const collectionResponse =
    await admin.graphql(
      `#graphql
        query LiveAuctionsCollection {
          collections(first: 50) {
            nodes {
              id
              title
              ruleSet {
                rules {
                  column
                  relation
                  condition
                }
              }
              products(first: 250) {
                nodes {
                  id
                }
              }
            }
          }
        }
      `,
    );

  const collectionJson =
    await collectionResponse.json();

  const liveCollection =
    collectionJson?.data?.collections?.nodes?.find(
      (collection) =>
        collection.title === "Live Auctions",
    );

  if (!liveCollection) {
    throw new Error(
      'The Shopify collection "Live Auctions" could not be found.',
    );
  }

  const alreadyInCollection =
    liveCollection.products.nodes.some(
      (product) =>
        product.id === productId,
    );

  if (
    !alreadyInCollection &&
    !liveCollection.ruleSet
  ) {
    const addResponse =
      await admin.graphql(
        `#graphql
          mutation AddAuctionToCollection(
            $id: ID!
            $productIds: [ID!]!
          ) {
            collectionAddProducts(
              id: $id
              productIds: $productIds
            ) {
              userErrors {
                message
              }
            }
          }
        `,
        {
          variables: {
            id: liveCollection.id,
            productIds: [productId],
          },
        },
      );

    const addJson =
      await addResponse.json();

    const addErrors =
      addJson?.data?.collectionAddProducts?.userErrors || [];

    if (addErrors.length) {
      throw new Error(
        addErrors
          .map((error) => error.message)
          .join(", "),
      );
    }
  }

  if (
    !alreadyInCollection &&
    liveCollection.ruleSet
  ) {
    throw new Error(
      'The "Live Auctions" collection is rule-based and does not currently include this auction product. Add the "Live Auction" tag or the "Hellfire Auction" product type to that collection rule.',
    );
  }

  for (const resourceId of [
    productId,
    liveCollection.id,
  ]) {
    const publishResponse =
      await admin.graphql(
        `#graphql
          mutation PublishAuctionResource(
            $id: ID!
            $publicationId: ID!
          ) {
            publishablePublish(
              id: $id
              input: {
                publicationId: $publicationId
              }
            ) {
              userErrors {
                message
              }
            }
          }
        `,
        {
          variables: {
            id: resourceId,
            publicationId:
              onlineStore.id,
          },
        },
      );

    const publishJson =
      await publishResponse.json();

    const publishErrors =
      publishJson?.data?.publishablePublish?.userErrors || [];

    if (publishErrors.length) {
      throw new Error(
        publishErrors
          .map((error) => error.message)
          .join(", "),
      );
    }
  }
}
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const timezone = await shopTimezone(admin);

  const showRemoved = new URL(request.url).searchParams.get("removed") === "1";
  const hiddenRows = await prisma.$queryRaw`
    SELECT n."auctionId" AS id FROM "AuctionNotification" n
    JOIN "Auction" a ON a."id" = n."auctionId"
    WHERE a."shop" = ${session.shop} AND n."type" = 'ADMIN_HIDDEN'`;
  const hiddenIds = hiddenRows.map((r) => r.id);
  const auctions = await prisma.auction.findMany({
    where: {
      shop: session.shop,
      ...(showRemoved ? { id: { in: hiddenIds } } : hiddenIds.length ? { id: { notIn: hiddenIds } } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
    take: new URL(request.url).searchParams.get("all") === "1" ? 500 : 60,
    select: {
      id: true,
      title: true,
      description: true,
      imageUrl: true,
      startingBid: true,
      currentBid: true,
      bidCount: true,
      startsAt: true,
      endsAt: true,
      status: true,
      reservePrice: true,
      productId: true,
      winnerId: true,
      winnerDraftOrderId: true,
      winnerNotifiedAt: true,
      autoExtend: true,
      isTest: true,
    },
  });

  // Leading bidder for every auction (merchant-only view).
  const ids = auctions.map((a) => a.id);
  const bids = ids.length
    ? await prisma.bid.findMany({
        where: { auctionId: { in: ids } },
        orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
        select: { id: true, auctionId: true, bidderId: true, maxBid: true, createdAt: true },
      })
    : [];
  const leaders = new Map();
  for (const bid of bids) if (!leaders.has(bid.auctionId)) leaders.set(bid.auctionId, bid);

  const bidsByAuction = new Map();
  for (const b of bids) {
    if (!bidsByAuction.has(b.auctionId)) bidsByAuction.set(b.auctionId, []);
    bidsByAuction.get(b.auctionId).push(b);
  }
  const blockedRows = await prisma.blockedBidder.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" }, take: 100 });

  const planNow = await getShopPlan(session.shop);
  runPaymentSweep().catch(() => {}); // pick up payments while the merchant is looking
  const totalAuctions = await prisma.auction.count({ where: { shop: session.shop } });
  const liveIds = auctions
    .filter((a) => new Date(a.startsAt).getTime() <= Date.now() && new Date(a.endsAt).getTime() > Date.now())
    .map((a) => a.id);
  const embedOff = liveIds.length
    ? (await prisma.auctionNotification.count({ where: { type: "EMBED_OFF", auctionId: { in: liveIds } } })) > 0
    : false;
  const sinceInsights = new Date(Date.now() - 30 * 24 * 3600_000);
  const endedRecent = await prisma.auction.findMany({
    where: { shop: session.shop, endsAt: { gte: sinceInsights, lte: new Date() }, status: { not: "CANCELLED" } },
    select: { title: true, currentBid: true, bidCount: true, winnerId: true },
  });
  const soldRecent = endedRecent.filter((a) => a.winnerId);
  const soldValue = soldRecent.reduce((sum, a) => sum + Number(a.currentBid || 0), 0);
  const best = [...soldRecent].sort((a, b) => Number(b.currentBid) - Number(a.currentBid))[0] || null;
  const liveNow = await prisma.auction.count({ where: { shop: session.shop, startsAt: { lte: new Date() }, endsAt: { gt: new Date() } } });
  const topRows = await prisma.bid.groupBy({
    by: ["bidderId"],
    where: { auction: { shop: session.shop } },
    _count: { _all: true },
    orderBy: { _count: { bidderId: "desc" } },
    take: 5,
  });

  const customerIds = [...new Set([...bids.map((b) => String(b.bidderId)), ...blockedRows.map((r) => String(r.customerId)), ...topRows.map((r) => String(r.bidderId))])].slice(0, 240);
  const customers = new Map();
  if (customerIds.length) {
    const gids = customerIds.map((id) => `gid://shopify/Customer/${id}`);
    for (const fields of ["id displayName email", "id email"]) {
      try {
        const response = await admin.graphql(
          `#graphql
            query HighBidders($ids: [ID!]!) {
              nodes(ids: $ids) { ... on Customer { ${fields} } }
            }`,
          { variables: { ids: gids } },
        );
        const json = await response.json();
        for (const node of json?.data?.nodes || []) {
          if (node?.id) customers.set(node.id.split("/").pop(), node);
        }
        break;
      } catch (error) {
        console.error(`[admin] high bidder lookup (${fields}) failed:`, error?.message || error);
      }
    }
  }

  const draftIds = auctions.filter((a) => a.winnerId && a.winnerDraftOrderId).map((a) => a.winnerDraftOrderId).slice(0, 50);
  const draftStatuses = new Map();
  if (draftIds.length) {
    try {
      const response = await admin.graphql(
        `#graphql
          query DraftStatuses($ids: [ID!]!) {
            nodes(ids: $ids) { ... on DraftOrder { id status } }
          }`,
        { variables: { ids: draftIds } },
      );
      for (const node of (await response.json())?.data?.nodes || []) {
        if (node?.id) draftStatuses.set(node.id, node.status);
      }
    } catch (error) {
      console.error("[admin] payment status lookup failed:", error?.message || error);
    }
  }

  // The store's own email addresses, so a bidder using one can be flagged (possible seller bidding).
  let storeEmails = new Set();
  const cachedEmails = storeEmailCache.get(session.shop);
  if (cachedEmails && Date.now() - cachedEmails.at < 3600_000) {
    storeEmails = cachedEmails.emails;
  } else {
    try {
      const sr = await admin.graphql(`#graphql
        query StoreEmails { shop { email contactEmail } }`);
      const sj = (await sr.json())?.data?.shop;
      for (const e of [sj?.email, sj?.contactEmail]) if (e) storeEmails.add(String(e).toLowerCase());
      storeEmailCache.set(session.shop, { at: Date.now(), emails: storeEmails });
    } catch {
      // flag simply won't show
    }
  }

  const weights = new Map(); // productId -> { value, unit }
  try {
    const weightIds = [...new Set(auctions.map((a) => a.productId))].slice(0, 100);
    if (weightIds.length) {
      const weightRes = await admin.graphql(
        `#graphql
          query CardWeights($ids: [ID!]!) {
            nodes(ids: $ids) { ... on Product { id variants(first: 1) { nodes { inventoryItem { measurement { weight { value unit } } } } } } }
          }`,
        { variables: { ids: weightIds } },
      );
      for (const node of (await weightRes.json())?.data?.nodes || []) {
        const w = node?.variants?.nodes?.[0]?.inventoryItem?.measurement?.weight;
        if (node?.id && w && Number(w.value) > 0) weights.set(node.id, { value: Number(w.value), unit: w.unit });
      }
    }
  } catch (error) {
    console.error("[admin] weights lookup failed:", error?.message || error);
  }

  const relistLeft = new Map(); // auctionId -> automatic relists still to come
  try {
    const relistMarks = await prisma.auctionNotification.findMany({
      where: { type: { in: ["AUTO_RELIST", "AUTO_RELISTED"] }, auctionId: { in: auctions.map((a) => a.id) } },
      select: { auctionId: true, type: true, key: true },
    });
    const relistDone = new Set(relistMarks.filter((m) => m.type === "AUTO_RELISTED").map((m) => m.auctionId));
    for (const m of relistMarks) if (m.type === "AUTO_RELIST" && !relistDone.has(m.auctionId)) relistLeft.set(m.auctionId, Number(m.key) || 0);
  } catch (error) {
    console.error("[admin] auto-relist lookup failed:", error?.message || error);
  }

  const settings = await getShopSettings(session.shop);
  const strikeMap = new Map(); // customerId -> unpaid sales on record
  try {
    const strikeRows = await prisma.$queryRaw`
      SELECT n."customerId" AS id, COUNT(*)::int AS n FROM "AuctionNotification" n
      JOIN "Auction" a ON a."id" = n."auctionId"
      WHERE a."shop" = ${session.shop} AND n."type" = 'STRIKE' GROUP BY n."customerId"`;
    for (const r of strikeRows) strikeMap.set(String(r.id), Number(r.n));
  } catch (error) {
    console.error("[admin] unpaid-sale counts failed:", error?.message || error);
  }

  const unpaidByWinner = new Map();
  for (const a of auctions) {
    if (!a.winnerId || !a.winnerDraftOrderId) continue;
    const s = draftStatuses.get(a.winnerDraftOrderId);
    if (s !== "OPEN" && s !== "INVOICE_SENT") continue;
    const e = unpaidByWinner.get(a.winnerId) || { n: 0, drafts: new Set() };
    e.n += 1;
    e.drafts.add(a.winnerDraftOrderId);
    unpaidByWinner.set(a.winnerId, e);
  }

  const auctionsWithLeaders = auctions.map((auction) => {
    const lead = auction.winnerId
      ? (bidsByAuction.get(auction.id) || []).find((b) => b.bidderId === auction.winnerId) || leaders.get(auction.id)
      : leaders.get(auction.id);
    const customer = lead ? customers.get(String(lead.bidderId)) : null;
    const list = bidsByAuction.get(auction.id) || [];
    const outcome = list.length
      ? resolveProxyBids({ startingBid: auction.startingBid, currentBid: 0, reservePrice: auction.reservePrice, bids: list })
      : null;
    const bidders = list
      .map((b) => {
        const c = customers.get(String(b.bidderId));
        return {
          customerId: String(b.bidderId),
          name: c?.displayName || c?.email || `Customer ${b.bidderId}`,
          email: c?.email || null,
          isStoreEmail: Boolean(c?.email && storeEmails.has(String(c.email).toLowerCase())),
          amount: outcome ? Number(outcome.amounts[b.id] ?? 0) : 0,
          isLeader: outcome ? outcome.leaderId === b.bidderId : false,
        };
      })
      .sort((x, y) => y.amount - x.amount)
      .slice(0, 25);
    return {
      ...auction,
      bidders,
      paymentStatus: auction.winnerDraftOrderId ? draftStatuses.get(auction.winnerDraftOrderId) || null : null,
      weight: weights.get(auction.productId) || null,
      winnerStrikes: auction.winnerId ? strikeMap.get(String(auction.winnerId)) || 0 : 0,
      autoRelistLeft: relistLeft.get(auction.id) || 0,
      winnerUnpaidCount: unpaidByWinner.get(auction.winnerId)?.n || 0,
      winnerDraftCount: unpaidByWinner.get(auction.winnerId)?.drafts.size || 0,
      payDeadline: auction.winnerId
        ? new Date(new Date(auction.winnerNotifiedAt || auction.endsAt).getTime() + 96 * 3600_000).toISOString()
        : null,
      hasOtherBidders: list.some((b) => b.bidderId !== auction.winnerId),
      highBidder: lead
        ? {
            customerId: String(lead.bidderId),
            name: customer?.displayName || customer?.email || `Customer ${lead.bidderId}`,
            email: customer?.email || null,
          }
        : null,
    };
  });

  const insights = {
    endedCount: endedRecent.length,
    soldCount: soldRecent.length,
    sellThrough: endedRecent.length ? Math.round((100 * soldRecent.length) / endedRecent.length) : null,
    soldValue,
    avgPrice: soldRecent.length ? soldValue / soldRecent.length : 0,
    avgBids: endedRecent.length ? endedRecent.reduce((s, a) => s + (a.bidCount || 0), 0) / endedRecent.length : 0,
    best: best ? { title: best.title, price: Number(best.currentBid) } : null,
    liveNow,
    topBidders: topRows.map((r) => {
      const c = customers.get(String(r.bidderId));
      return {
        customerId: String(r.bidderId),
        name: c?.displayName || c?.email || `Customer ${r.bidderId}`,
        email: c?.email || null,
        auctions: r._count._all,
      };
    }),
  };

  const blocked = blockedRows.map((r) => {
    const c = customers.get(String(r.customerId));
    return {
      customerId: String(r.customerId),
      name: c?.displayName || c?.email || `Customer ${r.customerId}`,
      email: c?.email || null,
    };
  });

  const storefrontActivationUrl = "https://" + session.shop + "/admin/themes/current/editor?context=apps&template=product&activateAppId=" + process.env.SHOPIFY_API_KEY + "/auction-runtime";

  let showMenuBanner = false;
  try {
    const { menu, hasLink } = await getMainMenu(admin);
    showMenuBanner = Boolean(menu) && !hasLink;
  } catch (error) {
    console.error("[admin] menu check skipped:", error?.message || error);
  }

  return { auctions: auctionsWithLeaders, storefrontActivationUrl, timezone, showMenuBanner, blocked, insights, moreAuctions: totalAuctions > auctions.length, embedOff, settings, removedCount: hiddenIds.length, showRemoved, adminBase: `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}`, liveBlockUrl: `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/themes/current/editor?template=index&addAppBlockId=${process.env.SHOPIFY_API_KEY}/live-auctions&target=newAppsSection`, shippingSettingsUrl: `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/settings/shipping`, planFlags: { name: planNow.name, insights: Boolean(planNow.insights), autoExtend: Boolean(planNow.autoExtend) } };
};

const actionImpl = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const timezone = await shopTimezone(admin);

  const intent =
    formData.get("intent")?.toString() || "create";

  if (intent === "add-menu-link") {
    try {
      return await addMyAuctionsToMenu(admin);
    } catch (error) {
      return { error: "Couldn't update your menu. Please open the app again and approve the new permission, then retry." };
    }
  }

  if (intent === "schedule-event") {
    const eventIds = [...new Set(formData.getAll("auctionIds").map((v) => String(v)))].slice(0, 100);
    const gapMinutes = Math.round(Number(formData.get("eventGap")));
    const evStartLocal = parseStoreLocal(formData.get("eventStart"));
    const evEndLocal = parseStoreLocal(formData.get("eventFirstEnd"));
    const evNow = new Date();
    const evTz = await shopTimezone(admin);
    const evStartAt = evStartLocal ? easternLocalToUtc(evStartLocal.date, evStartLocal.hour, evStartLocal.minute, evStartLocal.ampm, evTz) : null;
    const evFirstEnd = evEndLocal ? easternLocalToUtc(evEndLocal.date, evEndLocal.hour, evEndLocal.minute, evEndLocal.ampm, evTz) : null;
    const evProblem = validateEvent({
      count: eventIds.length,
      gapMinutes,
      startMs: evStartAt ? evStartAt.getTime() : NaN,
      firstEndMs: evFirstEnd ? evFirstEnd.getTime() : NaN,
      nowMs: evNow.getTime(),
    });
    if (evProblem) return { error: evProblem };
    const evStart = evStartAt.getTime() < evNow.getTime() ? evNow : evStartAt; // a start a minute ago means "start now"
    const evRows = await prisma.auction.findMany({ where: { id: { in: eventIds }, shop: session.shop } });
    const evById = new Map(evRows.map((r) => [r.id, r]));
    for (const id of eventIds) {
      const r = evById.get(id);
      if (!r) return { error: "One of the selected auctions could not be found." };
      if (r.startsAt.getTime() <= evNow.getTime() || r.bidCount > 0 || r.status === "ENDED" || r.status === "CANCELLED") {
        return { error: `"${r.title}" has already started, so it can't be part of an event. Only upcoming auctions can.` };
      }
    }
    const evEnds = staggeredEnds(evFirstEnd.getTime(), gapMinutes, eventIds.length);
    for (let i = 0; i < eventIds.length; i += 1) {
      await prisma.auction.update({ where: { id: eventIds[i] }, data: { startsAt: evStart, endsAt: evEnds[i], status: "UPCOMING" } });
    }
    wakeWorker();
    return {
      success: `Event scheduled: ${eventIds.length} auction${eventIds.length === 1 ? "" : "s"} start ${formatEastern(evStart, evTz)} and end one after another, ${gapMinutes} minute${gapMinutes === 1 ? "" : "s"} apart, from ${formatEastern(evEnds[0], evTz)} to ${formatEastern(evEnds[evEnds.length - 1], evTz)}.`,
      eventScheduled: true,
    };
  }

  if (intent === "save-bidder-rule") {
    const saved = await saveShopSettings(session.shop, {
      bidderRule: String(formData.get("bidderRule") || "ANYONE"),
      approvedTag: String(formData.get("approvedTag") || ""),
    });
    memoDelete("settings:" + session.shop); // the new rule applies to the very next bid
    return { success: saved.bidderRule === "ANYONE" ? "Anyone who is signed in can bid." : "Bidder rule saved. It applies to every new bid." };
  }

  if (intent === "save-default-weight") {
    const raw = String(formData.get("defaultWeight") || "").trim();
    const saved = await saveShopSettings(session.shop, {
      defaultWeight: raw === "" ? null : Number(raw),
      defaultWeightUnit: String(formData.get("defaultWeightUnit") || "OUNCES"),
    });
    return { success: saved.defaultWeight ? "Default shipping weight saved. New auctions without a weight will use it." : "Default shipping weight cleared." };
  }

  if (intent === "apply-default-weight") {
    const defaults = await getShopSettings(session.shop);
    if (!(defaults.defaultWeight > 0)) return { error: "Save a default weight first." };
    const recent = await prisma.auction.findMany({ where: { shop: session.shop }, select: { productId: true }, orderBy: { createdAt: "desc" }, take: 400 });
    const productIds = [...new Set(recent.map((r) => r.productId))].slice(0, 100);
    if (!productIds.length) return { success: "There are no auctions yet." };
    let missing = [];
    try {
      const response = await admin.graphql(
        `#graphql
          query DefaultWeightCheck($ids: [ID!]!) {
            nodes(ids: $ids) { ... on Product { id variants(first: 1) { nodes { inventoryItem { measurement { weight { value } } } } } } }
          }`,
        { variables: { ids: productIds } },
      );
      for (const node of (await response.json())?.data?.nodes || []) {
        const current = node?.variants?.nodes?.[0]?.inventoryItem?.measurement?.weight?.value;
        if (node?.id && !(Number(current) > 0)) missing.push(node.id);
      }
    } catch (error) {
      return { error: "Couldn't read your products from Shopify: " + (error?.message || error) };
    }
    let applied = 0;
    for (const id of missing) {
      try {
        await setAuctionWeight(admin, id, defaults.defaultWeight, defaults.defaultWeightUnit);
        applied += 1;
      } catch (error) {
        console.error("[admin] could not apply the default weight:", error?.message || error);
      }
    }
    return { success: applied ? `Added the default weight to ${applied} auction product${applied === 1 ? "" : "s"} that had none.` : "Every recent auction product already has a weight." };
  }

  if (intent === "save-settings") {
    await saveShopSettings(session.shop, {
      autoOfferNext: formData.get("autoOfferNext") === "on",
      strikeLimit: Number(formData.get("strikeLimit")),
    });
    return { success: "Unpaid winner settings saved." };
  }

  if (intent === "set-weight") {
    const weightAuctionId = formData.get("auctionId")?.toString() || "";
    const weightTarget = await prisma.auction.findFirst({ where: { id: weightAuctionId, shop: session.shop }, select: { productId: true } });
    if (!weightTarget) return { error: "Auction could not be found." };
    const quickValue = Number(formData.get("weightValue"));
    const quickUnitRaw = String(formData.get("weightUnit") || "");
    const quickUnit = ["OUNCES", "POUNDS", "GRAMS", "KILOGRAMS"].includes(quickUnitRaw) ? quickUnitRaw : "OUNCES";
    if (!Number.isFinite(quickValue) || quickValue <= 0) return { error: "Enter a weight greater than zero." };
    try {
      await setAuctionWeight(admin, weightTarget.productId, quickValue, quickUnit);
    } catch (error) {
      return { error: "Couldn't save the weight in Shopify: " + (error?.message || error) };
    }
    return { success: "Shipping weight saved." };
  }

  if (["hide-auction", "unhide-auction", "hide-paid"].includes(intent)) {
    if (intent === "hide-paid") {
      const paidRows = await prisma.$queryRaw`
        SELECT n."auctionId" AS id FROM "AuctionNotification" n
        JOIN "Auction" a ON a."id" = n."auctionId"
        WHERE a."shop" = ${session.shop} AND n."type" = 'PAID'`;
      if (!paidRows.length) return { success: "There are no paid auctions to clear." };
      await prisma.auctionNotification.createMany({
        data: paidRows.map((r) => ({ auctionId: r.id, customerId: "__admin__", type: "ADMIN_HIDDEN", key: "1" })),
        skipDuplicates: true,
      });
      return { success: `Removed ${paidRows.length} paid auction${paidRows.length === 1 ? "" : "s"} from the list. Your records and insights are unchanged. Use "Show removed" to bring any back.` };
    }
    const hideId = formData.get("auctionId")?.toString() || "";
    const owned = await prisma.auction.findFirst({ where: { id: hideId, shop: session.shop }, select: { id: true } });
    if (!owned) return { error: "Auction could not be found." };
    if (intent === "hide-auction") {
      await prisma.auctionNotification.createMany({ data: [{ auctionId: hideId, customerId: "__admin__", type: "ADMIN_HIDDEN", key: "1" }], skipDuplicates: true });
      return { success: "Removed from the list. Use \"Show removed\" to bring it back." };
    }
    await prisma.auctionNotification.deleteMany({ where: { auctionId: hideId, type: "ADMIN_HIDDEN" } });
    return { success: "Restored to the list." };
  }

  if (["remind-winner", "offer-next", "cancel-sale", "combine-wins"].includes(intent)) {
    const id = formData.get("auctionId")?.toString() || "";
    try {
      if (intent === "combine-wins") {
        const one = await prisma.auction.findFirst({ where: { id, shop: session.shop } });
        if (!one?.winnerId) return { error: "This auction has no winner." };
        const r = await combineWinnerInvoices(session.shop, one.winnerId, { notifyBuyer: true });
        return r.error ? { error: r.error } : { success: `Combined ${r.count} wins into one invoice and emailed the buyer the new link.` };
      }
      if (intent === "remind-winner") return await remindWinnerNow(session.shop, id);
      if (intent === "offer-next") return await offerToNextBidder(session.shop, id);
      return await cancelUnpaidSale(session.shop, id);
    } catch (error) {
      console.error("[admin] unpaid-winner action failed:", intent, error?.message || error);
      return { error: "That didn't work: " + (error?.message || "unknown error") };
    }
  }

  if (["remove-bid", "block-bidder", "unblock-bidder"].includes(intent)) {
    const targetCustomer = formData.get("customerId")?.toString() || "";
    if (!targetCustomer) return { error: "Bidder could not be found." };

    if (intent === "unblock-bidder") {
      await prisma.blockedBidder.deleteMany({ where: { shop: session.shop, customerId: targetCustomer } });
      return { success: "Bidder unblocked. They can bid again." };
    }

    // remove-bid: this auction only. block-bidder: every live auction in the store.
    let targets;
    if (intent === "block-bidder") {
      await prisma.blockedBidder.upsert({
        where: { shop_customerId: { shop: session.shop, customerId: targetCustomer } },
        create: { shop: session.shop, customerId: targetCustomer },
        update: {},
      });
      targets = await prisma.auction.findMany({
        where: { shop: session.shop, endsAt: { gt: new Date() }, bids: { some: { bidderId: targetCustomer } } },
      });
    } else {
      const one = await prisma.auction.findFirst({ where: { id: formData.get("auctionId")?.toString() || "", shop: session.shop } });
      if (!one) return { error: "Auction could not be found." };
      if (new Date() >= one.endsAt) {
        return { error: "This auction has already ended, so bids can't be removed. If there's a problem with the item, use End now with no sale." };
      }
      targets = [one];
    }

    let removed = 0;
    for (const a of targets) {
      const mine = await prisma.bid.findFirst({ where: { auctionId: a.id, bidderId: targetCustomer } });
      if (!mine) continue;
      await prisma.$transaction(async (tx) => {
        await tx.bid.delete({ where: { id: mine.id } });
        await tx.bidEvent.deleteMany({ where: { auctionId: a.id, bidderId: targetCustomer } });
        const evCount = await tx.bidEvent.count({ where: { auctionId: a.id } });
        const rest = await tx.bid.findMany({
          where: { auctionId: a.id },
          select: { id: true, bidderId: true, maxBid: true, createdAt: true },
        });
        const outcome = rest.length
          ? resolveProxyBids({ startingBid: a.startingBid, currentBid: 0, reservePrice: a.reservePrice, bids: rest })
          : null;
        await tx.auction.update({
          where: { id: a.id },
          data: {
            currentBid: outcome ? outcome.price : a.startingBid,
            bidCount: rest.length ? (evCount > 0 ? evCount : Math.max(rest.length, a.bidCount - 1)) : 0,
          },
        });
      });
      removed += 1;
    }
    return {
      success:
        intent === "block-bidder"
          ? `Bidder blocked. ${removed} live bid${removed === 1 ? "" : "s"} removed and prices recalculated.`
          : removed
            ? "Bid removed. The price and leader have been recalculated."
            : "That bidder has no bid on this auction.",
    };
  }

  if (["cancel", "end", "relist", "delete"].includes(intent)) {
    const target = await prisma.auction.findFirst({
      where: { id: formData.get("auctionId")?.toString() || "", shop: session.shop },
    });
    if (!target) return { error: "Auction could not be found." };
    const now = new Date();
    const ended = now >= target.endsAt || target.status === "CANCELLED";

    const setProductStatus = async (status) => {
      const res = await admin.graphql(
        `#graphql
          mutation SetAuctionProductStatus($product: ProductUpdateInput!) {
            productUpdate(product: $product) { userErrors { message } }
          }`,
        { variables: { product: { id: target.productId, status } } },
      );
      const json = await res.json();
      const errors = json?.data?.productUpdate?.userErrors || [];
      if (errors.length) throw new Error(errors.map((x) => x.message).join(", "));
    };
    const liveCollection = async (add) => {
      const collection = await ensureLiveAuctionsCollection(admin);
      if (!collection?.id) return;
      await admin.graphql(
        add
          ? `#graphql
              mutation JoinLive($id: ID!, $productIds: [ID!]!) {
                collectionAddProducts(id: $id, productIds: $productIds) { userErrors { message } }
              }`
          : `#graphql
              mutation LeaveLive($id: ID!, $productIds: [ID!]!) {
                collectionRemoveProducts(id: $id, productIds: $productIds) { userErrors { message } }
              }`,
        { variables: { id: collection.id, productIds: [target.productId] } },
      );
    };

    // Admin authority: end now WITHOUT a sale (e.g. a problem with the item). Nobody is invoiced.
    if (intent === "cancel" || intent === "end") {
      if (ended) return { error: "This auction has already ended." };
      await prisma.auction.update({
        where: { id: target.id },
        data: { endsAt: now, status: "CANCELLED", winnerId: null },
      });
      try {
        await setProductStatus("DRAFT");
        await liveCollection(false);
      } catch (error) {
        console.error("[admin] hide ended product failed:", error?.message || error);
      }
      return { success: "Auction ended early with no sale. Nobody will be invoiced, and the product is hidden from your store." };
    }

    // Relist an unsold auction with a length the merchant chooses.
    if (intent === "relist") {
      if (!ended) return { error: "Only ended auctions can be relisted." };
      if (target.winnerId) return { error: "This auction sold, so it can't be relisted." };
      const durationValue = formData.get("durationDays")?.toString() || "";
      if (!isDurationOption(durationValue)) return { error: "Choose how long the relisted auction should run." };
      const quota = await canCreateAuction(session.shop);
      if (!quota.allowed) {
        return { error: `You've used all ${quota.limit} auctions on the ${quota.plan.name} plan this month. Upgrade on the "Plans & upgrades" page for more.` };
      }
      try {
        await setProductStatus("ACTIVE");
        await liveCollection(true);
        await ensureAuctionStorefront(admin, target.productId); // republish if it was taken off the store
      } catch (error) {
        return { error: "Couldn't put the product back on sale in Shopify: " + (error?.message || error) };
      }
      await prisma.auction.create({
        data: {
          shop: target.shop,
          productId: target.productId,
          title: target.title,
          description: target.description,
          imageUrl: target.imageUrl,
          startingBid: target.startingBid,
          currentBid: target.startingBid,
          reservePrice: target.reservePrice,
          autoExtend: target.autoExtend,
          isTest: durationValue.startsWith("m"),
          startsAt: now,
          endsAt: new Date(now.getTime() + durationMs(durationValue)),
          status: "LIVE",
        },
      });
      return { success: `Relisted! The auction is live again for ${DURATION_OPTIONS.find((o) => o.value === durationValue).label.toLowerCase()}.` };
    }

    // Delete an ended auction (and its product, unless another auction still uses it).
    if (intent === "delete") {
      if (!ended) return { error: "Only ended auctions can be deleted. End it first if there's a problem." };
      if (target.winnerId && target.winnerDraftOrderId) {
        let paid = false;
        try {
          const res = await admin.graphql(
            `#graphql
              query WinnerInvoice($id: ID!) { draftOrder(id: $id) { status } }`,
            { variables: { id: target.winnerDraftOrderId } },
          );
          paid = (await res.json())?.data?.draftOrder?.status === "COMPLETED";
        } catch {}
        if (!paid) {
          if (formData.get("force") !== "1") {
            return { error: "The winner hasn't paid their invoice yet. Use Cancel sale first, or confirm the deletion prompt to cancel their invoice and delete the auction." };
          }
          try {
            await releaseDraftFor(session.shop, target);
          } catch {
            // the invoice may already be gone; continue with the deletion
          }
        }
      }
      const others = await prisma.auction.count({ where: { productId: target.productId, id: { not: target.id } } });
      if (!others) {
        try {
          const res = await admin.graphql(
            `#graphql
              mutation DeleteAuctionProduct($input: ProductDeleteInput!) {
                productDelete(input: $input) { deletedProductId userErrors { message } }
              }`,
            { variables: { input: { id: target.productId } } },
          );
          const errors = (await res.json())?.data?.productDelete?.userErrors || [];
          if (errors.length && !/not\s*(be\s*)?found|does not exist/i.test(errors.map((x) => x.message).join(" "))) {
            return { error: "Shopify wouldn't delete the product: " + errors.map((x) => x.message).join(", ") };
          }
        } catch (error) {
          return { error: "Couldn't delete the product from Shopify: " + (error?.message || error) };
        }
      }
      await prisma.auctionNotification.deleteMany({ where: { auctionId: target.id } });
      await prisma.auction.delete({ where: { id: target.id } }); // bids are removed with it
      return { success: others ? "Auction deleted. The product was kept because a relisted auction still uses it." : "Auction and its product deleted." };
    }
  }

  if (intent === "create") {
    const quota = await canCreateAuction(session.shop);
    if (!quota.allowed) {
      return {
        error: `You've used all ${quota.limit} auctions on the ${quota.plan.name} plan this month. Upgrade on the "Plans & upgrades" page for more.`,
      };
    }
  }

  // Spreadsheet import: exact start and end times in the store's time zone ("YYYY-MM-DDTHH:mm").
  const customStart = parseStoreLocal(formData.get("customStartLocal"));
  const customEnd = parseStoreLocal(formData.get("customEndLocal"));

  const title =
    formData.get("title")?.toString().trim();

  const description =
    formData.get("description")?.toString().trim() || "";

  const startingBid =
    Math.round(Number(formData.get("startingBid")) * 100) / 100;

  const reservePriceValue =
    formData.get("reservePrice");

  const startsAtDate =
    customStart?.date ?? formData.get("startsAtDate")?.toString();

  const startsAtHour =
    customStart?.hour ?? formData.get("startsAtHour")?.toString();

  const startsAtMinute =
    customStart?.minute ?? formData.get("startsAtMinute")?.toString();

  const startsAtAmPm =
    customStart?.ampm ?? formData.get("startsAtAmPm")?.toString();

  const durationValue =
    formData.get("durationDays")?.toString() || "";

  const imageFile = formData.get("image");

  if (
    !title ||
    !Number.isFinite(startingBid) ||
    startingBid <= 0 ||
    !startsAtDate ||
    !startsAtHour ||
    !startsAtMinute ||
    !startsAtAmPm ||
    (!customEnd && !isDurationOption(durationValue))
  ) {
    return {
      error: "Please complete all required auction fields.",
    };
  }

  let startsAt = easternLocalToUtc(
    startsAtDate,
    startsAtHour,
    startsAtMinute,
    startsAtAmPm,
    timezone,
  );

  if (intent === "create") {
    const nowMs = Date.now();
    if (startsAt.getTime() < nowMs - 5 * 60 * 1000) {
      return { error: "That start time has already passed. Pick the current time (or click \u201CStart now\u201D) or a time in the future." };
    }
    if (startsAt.getTime() < nowMs) startsAt = new Date(nowMs); // chosen minute just passed: start right now
  }

  let endsAt = new Date(startsAt.getTime() + (customEnd ? 0 : durationMs(durationValue)));
  if (customEnd) {
    endsAt = easternLocalToUtc(customEnd.date, customEnd.hour, customEnd.minute, customEnd.ampm, timezone);
    if (endsAt.getTime() < startsAt.getTime() + 60 * 60 * 1000) {
      return { error: "Each auction must end at least 1 hour after it starts." };
    }
  }

  const reservePrice =
    reservePriceValue !== null &&
    reservePriceValue !== ""
      ? Math.round(Number(reservePriceValue) * 100) / 100
      : null;

  if (intent === "create" && reservePrice !== null && !(Number.isFinite(reservePrice) && reservePrice > startingBid)) {
    return { error: "The reserve price must be higher than the starting bid. Leave it empty if you don't want a reserve." };
  }

  const cleanDescription = description
    ? `<p>${description
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\n", "<br>")}</p>`
    : "";

  /*
   * EDIT EXISTING AUCTION
   */
  if (intent === "update") {
    const auctionId =
      formData.get("auctionId")?.toString();

    if (!auctionId) {
      return {
        error: "Auction ID is missing.",
      };
    }

    const existingAuction =
      await prisma.auction.findFirst({
        where: {
          id: auctionId,
          shop: session.shop,
        },
      });

    if (!existingAuction) {
      return {
        error: "Auction could not be found.",
      };
    }

    // Price and schedule are locked once listed: they are never changed below.
    // eBay rules: once the auction has started the title is locked, the description can only be
    // ADDED to (dated note), and photos can only be added.
    const started = new Date() >= existingAuction.startsAt;
    const addText = (formData.get("addDescription")?.toString() || "").trim();
    let finalTitle = title;
    let finalPlain = description || "";
    if (started) {
      finalTitle = existingAuction.title;
      finalPlain = existingAuction.description || "";
      if (addText) {
        finalPlain = (finalPlain ? finalPlain + "\n\n" : "") + `Added ${formatEastern(new Date(), timezone)}: ${addText}`;
      }
    }
    const finalHtml = finalPlain
      ? `<p>${finalPlain.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>")}</p>`
      : "";
    const skipProductUpdate = started && !addText;

    // The shipping weight can be added or changed at any time: it doesn't change the bidding terms.
    const editWeight = Number(formData.get("weightValue"));
    if (Number.isFinite(editWeight) && editWeight > 0) {
      const editUnitRaw = String(formData.get("weightUnit") || "");
      const editUnit = ["OUNCES", "POUNDS", "GRAMS", "KILOGRAMS"].includes(editUnitRaw) ? editUnitRaw : "OUNCES";
      try {
        await setAuctionWeight(admin, existingAuction.productId, editWeight, editUnit);
      } catch (error) {
        return { error: "Couldn't save the shipping weight in Shopify: " + (error?.message || error) };
      }
    }

    /*
     * Update the existing Shopify product.
     */
    const productUpdateResponse =
      await admin.graphql(
        `#graphql
          mutation UpdateAuctionProduct(
            $product: ProductUpdateInput!
          ) {
            productUpdate(product: $product) {
              product {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            product: skipProductUpdate
              ? { id: existingAuction.productId }
              : { id: existingAuction.productId, title: finalTitle, descriptionHtml: finalHtml },
          },
        },
      );

    const productUpdateJson =
      await productUpdateResponse.json();

    const productErrors =
      productUpdateJson?.data?.productUpdate?.userErrors || [];

    if (productErrors.length) {
      return {
        error: productErrors
          .map((error) => error.message)
          .join(", "),
      };
    }

    let imageUrl = existingAuction.imageUrl;

    const newFiles = formData
      .getAll("image")
      .filter((f) => f && typeof f === "object" && f.size > 0)
      .slice(0, 10);
    console.log("[admin] photos received on edit:", newFiles.length);
    if (newFiles.some((f) => !f.type?.startsWith("image/"))) {
      return { error: "Photos must be image files." };
    }
    if (newFiles.length) {
      const sources = [];
      for (const f of newFiles) sources.push(await uploadImage(admin, f));
      const mediaResponse = await admin.graphql(
        `#graphql
          mutation AddAuctionMedia($productId: ID!, $media: [CreateMediaInput!]!) {
            productCreateMedia(productId: $productId, media: $media) {
              media { id }
              mediaUserErrors { message }
            }
          }
        `,
        {
          variables: {
            productId: existingAuction.productId,
            media: sources.map((src) => ({ originalSource: src, alt: finalTitle, mediaContentType: "IMAGE" })),
          },
        },
      );
      const mediaErrors = (await mediaResponse.json())?.data?.productCreateMedia?.mediaUserErrors || [];
      if (mediaErrors.length) {
        return { error: mediaErrors.map((error) => error.message).join(", ") };
      }
      // The FIRST photo stays the main one (invoices, packing slips); new photos are added after it.
      if (!imageUrl) {
        const productImage = await getProductImage(admin, existingAuction.productId);
        if (productImage.url) imageUrl = productImage.url;
      }
    }

    /*
     * Never reset the current bid if bidders already exist.
     * If there are no bids, keep current bid synchronized
     * with the edited starting bid.
     */
    const bidCount = await prisma.bid.count({
      where: {
        auctionId: auctionId,
      },
    });

    try {
      await ensureAuctionVariantAvailable(
        admin,
        existingAuction.productId,
      );
      await ensureAuctionStorefront(
        admin,
        existingAuction.productId,
      );
    } catch (error) {
      return {
        error: error.message,
      };
    }

    const updatedAuction =
      await prisma.auction.update({
        where: {
          id: auctionId,
        },
        data: {
          title: finalTitle,
          description: finalPlain || null,
          imageUrl,
        },
      });

    return {
      success: true,
      mode: "update",
      auctionId: updatedAuction.id,
    };
  }

  /*
   * CREATE NEW AUCTION
   */
  const cloneImageUrl = formData.get("cloneImageUrl")?.toString() || "";
  const hasUpload = Boolean(imageFile && typeof imageFile === "object" && imageFile.size > 0);
  // Shopify itself fetches the photo from this link, so any https link works (Shopify rejects anything that is not an image).
  const useCopiedPhoto = !hasUpload && /^https:\/\/[^\s]{4,2000}$/.test(cloneImageUrl);

  if (!hasUpload && !useCopiedPhoto) {
    return {
      error: "Please upload an auction image.",
    };
  }

  if (hasUpload && !imageFile.type?.startsWith("image/")) {
    return {
      error: "Please upload an image file.",
    };
  }

  /*
   * The app owns the Live Auctions collection.
   * Create it automatically when it does not exist.
   */
  let liveCollection;

  try {
    liveCollection = await ensureLiveAuctionsCollection(admin);
  } catch (error) {
    return { error: error.message };
  }

  const uploadFiles = formData
    .getAll("image")
    .filter((f) => f && typeof f === "object" && f.size > 0)
    .slice(0, 10);
  console.log("[admin] photos received on create:", uploadFiles.length);
  if (uploadFiles.some((f) => !f.type?.startsWith("image/"))) {
    return { error: "Photos must be image files." };
  }
  const stagedSources = [];
  if (uploadFiles.length) {
    for (const f of uploadFiles) stagedSources.push(await uploadImage(admin, f));
  } else {
    stagedSources.push(cloneImageUrl);
  }

  const productResponse =
    await admin.graphql(
      `#graphql
        mutation CreateAuctionProduct(
          $product: ProductCreateInput!
          $media: [CreateMediaInput!]
        ) {
          productCreate(
            product: $product
            media: $media
          ) {
            product {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: {
          product: {
            title,
            descriptionHtml: cleanDescription,
            status: startsAt > new Date() ? "DRAFT" : "ACTIVE",
            productType: "Hellfire Auction",
            vendor: await shopDisplayName(admin),
            tags: [
              "Hellfire Auction",
              "Live Auction",
            ],
            collectionsToJoin: [
              liveCollection.id,
            ],
          },
          media: stagedSources.map((src) => ({ originalSource: src, alt: title, mediaContentType: "IMAGE" })),
        },
      },
    );

  const productJson =
    await productResponse.json();

  const productResult =
    productJson?.data?.productCreate;

  if (productResult?.userErrors?.length) {
    return {
      error: productResult.userErrors
        .map((error) => error.message)
        .join(", "),
    };
  }

  const productId =
    productResult?.product?.id;

  if (!productId) {
    return {
      error:
        "Shopify did not return the new product ID.",
    };
  }

  try {
    await ensureAuctionVariantAvailable(admin, productId);
    let weightValue = Number(formData.get("weightValue"));
    const weightUnitRaw = String(formData.get("weightUnit") || "");
    let weightUnit = ["OUNCES", "POUNDS", "GRAMS", "KILOGRAMS"].includes(weightUnitRaw) ? weightUnitRaw : "OUNCES";
    if (!(Number.isFinite(weightValue) && weightValue > 0)) {
      // no weight entered: use the store's default, so weight-based shipping rates always have something to work with
      const shopDefaults = await getShopSettings(session.shop);
      if (shopDefaults.defaultWeight > 0) {
        weightValue = shopDefaults.defaultWeight;
        weightUnit = shopDefaults.defaultWeightUnit;
      }
    }
    if (Number.isFinite(weightValue) && weightValue > 0) {
      try {
        await setAuctionWeight(admin, productId, weightValue, weightUnit);
      } catch (error) {
        console.error("[admin] could not set the shipping weight:", error?.message || error);
      }
    }
    await ensureAuctionStorefront(admin, productId);
  } catch (error) {
    return { error: error.message };
  }

  const productImage =
    await getProductImage(admin, productId);

  const auction =
    await prisma.auction.create({
      data: {
        shop: session.shop,
        productId,
        title,
        description: description || null,
        imageUrl: productImage.url,
        startingBid,
        currentBid: startingBid,
        reservePrice:
          reservePrice !== null &&
          Number.isFinite(reservePrice)
            ? reservePrice
            : null,
        autoExtend: formData.get("autoExtend") === "1" && Boolean((await getShopPlan(session.shop)).autoExtend),
        isTest: durationValue.startsWith("m"),
        startsAt,
        endsAt,
        status: startsAt > new Date() ? "UPCOMING" : (new Date() < endsAt ? "LIVE" : "ENDED"),
      },
    });

  // "If it doesn't sell, relist automatically" (up to 3 times); the worker does the relisting.
  const relistTimes = Math.min(3, Math.max(0, Math.round(Number(formData.get("autoRelist")) || 0)));
  if (relistTimes > 0 && !durationValue.startsWith("m")) {
    await prisma.auctionNotification.create({ data: { auctionId: auction.id, customerId: "__admin__", type: "AUTO_RELIST", key: String(relistTimes) } }).catch(() => {});
  }

  return {
    success: true,
    mode: "create",
    auctionId: auction.id,
  };
};

/* eslint-disable react/prop-types */
/* eslint-disable react/prop-types */
function AuctionForm({
  auction,
  prefill,
  onCancel,
  timezone,
  allowAutoExtend,
}) {
  const isEdit = Boolean(auction);
  const source = auction || prefill || null;
  const locked = Boolean(auction) && new Date(auction.startsAt).getTime() <= Date.now();

  const initialParts = auction
    ? getEasternParts(auction.startsAt, timezone)
    : prefill
      ? getEasternParts(new Date(), timezone)
      : null;

  const [startDate, setStartDate] =
    useState(
      initialParts?.date || easternToday(timezone),
    );

  const [startHour, setStartHour] =
    useState(
      initialParts?.hour ? String(Number(initialParts.hour)) : "7",
    );

  const [startMinute, setStartMinute] =
    useState(
      initialParts?.minute || "00",
    );

  const [startAmPm, setStartAmPm] =
    useState(
      initialParts?.ampm || "PM",
    );

  const [duration, setDuration] =
    useState(() => {
      if (!source) return "7";

      const length =
        new Date(source.endsAt).getTime() -
        new Date(source.startsAt).getTime();
      const match = DURATION_OPTIONS.find(
        (option) => Math.abs(durationMs(option.value) - length) < 60 * 1000,
      );
      return match ? match.value : "7";
    });

  const [imagePreview, setImagePreview] =
    useState(
      source?.imageUrl || null,
    );

  const [photoCount, setPhotoCount] = useState(0);
  const [thumbs, setThumbs] = useState([]);

  const calculateEndPreview = () => {
    try {
      const start = easternLocalToUtc(
        startDate,
        startHour,
        startMinute,
        startAmPm,
        timezone,
      );

      const end = new Date(
        start.getTime() +
          durationMs(duration),
      );

      return formatEastern(end, timezone);
    } catch {
      return "Choose a valid start time";
    }
  };

  const handleImageChange = (event) => {
    setPhotoCount(event.currentTarget.files?.length || 0);
    setThumbs(
      Array.from(event.currentTarget.files || [])
        .filter((f) => f.type?.startsWith("image/"))
        .slice(0, 10)
        .map((f) => URL.createObjectURL(f)),
    );
    const file =
      event.currentTarget.files?.[0];

    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setImagePreview(
        source?.imageUrl || null,
      );
      return;
    }

    setImagePreview(
      URL.createObjectURL(file),
    );
  };

  return (
    <Form
      method="post"
      encType="multipart/form-data"
    >
      <input
        type="hidden"
        name="intent"
        value={isEdit ? "update" : "create"}
      />

      {isEdit && (
        <input
          type="hidden"
          name="auctionId"
          value={auction.id}
        />
      )}

      <s-stack gap="base">

        {locked ? (
          <s-stack gap="small">
            <input type="hidden" name="title" value={auction.title} />
            <s-text><strong>{auction.title}</strong></s-text>
            {auction.description && (
              <div style={{ whiteSpace: "pre-wrap", fontSize: 14, color: "#303030" }}>{auction.description}</div>
            )}
            <s-banner tone="info">
              This auction has started, so the title is locked. As on other auction sites, you can add to the description (it's added below the original, with the date) and add photos.
            </s-banner>
            <s-text-area
              label="Add to description"
              name="addDescription"
              placeholder="New details, such as a measurement or something you noticed..."
            />
          </s-stack>
        ) : (
          <>
            <s-text-field
              label="Auction Title"
              name="title"
              placeholder="Example: One-of-a-kind collectible"
              value={source?.title || undefined}
              required
            />

            <s-text-area
              label="Description"
              name="description"
              placeholder="Describe the item being auctioned..."
              value={source?.description || undefined}
            />
          </>
        )}

        <s-section
          heading={
            isEdit
              ? "Add Photos"
              : "Auction Image"
          }
        >
          <s-stack gap="small">

            <label
              style={{
                display: "block",
                border: "2px dashed #8a8a8a",
                borderRadius: 12,
                padding: "16px",
                textAlign: "center",
                cursor: "pointer",
                background: "#fafafa",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {isEdit
                  ? "Add more photos (optional, up to 10)"
                  : prefill
                    ? "Keep this photo or choose new ones (up to 10)"
                    : "Upload auction photos (up to 10, the first is the main photo)"}
              </div>
              <div style={{ fontSize: 13, color: "#616161", marginBottom: 8 }}>
                Click below to choose photos. Select several at once by holding Ctrl (or Cmd) or Shift.
              </div>
              <input
                type="file"
                name="image"
                accept="image/*"
                multiple
                required={!isEdit && !prefill}
                onChange={handleImageChange}
                style={{ maxWidth: "100%" }}
              />
            </label>

            {prefill?.imageUrl && <input type="hidden" name="cloneImageUrl" value={prefill.imageUrl} />}

            {photoCount > 0 && (
              <div>
                <div style={{ fontSize: 13, marginBottom: 6 }}>
                  {photoCount} photo{photoCount === 1 ? "" : "s"} selected{photoCount > 10 ? " (only the first 10 will be used)" : ""}. The first one is the main photo shown on cards, invoices and packing slips.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {thumbs.map((src, i) => (
                    <img key={src} src={src} alt={`Preview ${i + 1}`} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: i === 0 ? "3px solid #008060" : "1px solid #ccc" }} />
                  ))}
                </div>
              </div>
            )}

            {imagePreview && (
              <img
                src={imagePreview}
                alt="Auction preview"
                style={{
                  width: "240px",
                  height: "240px",
                  objectFit: "cover",
                  borderRadius: "12px",
                  display: "block",
                }}
              />
            )}

          </s-stack>
        </s-section>

        {isEdit ? (
          <s-section heading="Price and schedule (locked)">
            <s-stack gap="small">
              <s-text>Starting Bid: ${Number(auction.startingBid).toFixed(2)}</s-text>
              <s-text>
                Reserve Price:{" "}
                {auction.reservePrice != null
                  ? `$${Number(auction.reservePrice).toFixed(2)}`
                  : "None"}
              </s-text>
              <s-text>Starts: {formatEastern(new Date(auction.startsAt), timezone)}</s-text>
              <s-text>Ends: {formatEastern(new Date(auction.endsAt), timezone)}</s-text>
              <s-text>
                Once an auction is listed, its price and schedule can't be changed, so every bidder is treated exactly the same.
              </s-text>
            </s-stack>
            <input type="hidden" name="startingBid" value={String(auction.startingBid)} />
            <input type="hidden" name="reservePrice" value={auction.reservePrice != null ? String(auction.reservePrice) : ""} />
            <input type="hidden" name="startsAtDate" value={startDate} />
            <input type="hidden" name="startsAtHour" value={startHour} />
            <input type="hidden" name="startsAtMinute" value={startMinute} />
            <input type="hidden" name="startsAtAmPm" value={startAmPm} />
            <input type="hidden" name="durationDays" value={duration} />
          </s-section>
        ) : (
          <>
        <s-number-field
          label="Starting Bid"
          name="startingBid"
          min="0.01"
          step="0.01"
          placeholder="25.00"
          value={
            source
              ? String(source.startingBid)
              : undefined
          }
          required
        />

        <s-number-field
          label="Reserve Price"
          name="reservePrice"
          min="0"
          step="0.01"
          placeholder="Optional"
          value={
            source?.reservePrice != null
              ? String(source.reservePrice)
              : undefined
          }
        />

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, opacity: allowAutoExtend ? 1 : 0.6 }}>
          <input
            type="checkbox"
            name="autoExtend"
            value="1"
            defaultChecked={Boolean(source?.autoExtend) && Boolean(allowAutoExtend)}
            disabled={!allowAutoExtend}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>Anti-sniping:</strong> add 2 minutes if a bid arrives in the last 2 minutes.
            {!allowAutoExtend && " (Inferno plan)"}
          </span>
        </label>

        {!isEdit && !String(duration).startsWith("m") && (
          <label style={{ display: "grid", gap: 6 }}>
            <strong>If it doesn&rsquo;t sell</strong>
            <select name="autoRelist" defaultValue="0" style={{ padding: "10px 12px", border: "1px solid #8a8a8a", borderRadius: 8, maxWidth: 320 }}>
              <option value="0">Don&rsquo;t relist</option>
              <option value="1">Relist it automatically once</option>
              <option value="2">Relist it automatically up to 2 times</option>
              <option value="3">Relist it automatically up to 3 times</option>
            </select>
            <span style={{ fontSize: 13, color: "#616161" }}>An unsold item goes live again for the same length, about a minute after it ends.</span>
          </label>
        )}

        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Shipping weight (optional)</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input name="weightValue" type="number" min="0" step="0.01" placeholder="e.g. 8" defaultValue={source?.weight?.value ?? ""} style={{ padding: "10px 12px", border: "1px solid #8a8a8a", borderRadius: 8, width: 120 }} />
            <select name="weightUnit" defaultValue={source?.weight?.unit || "OUNCES"} style={{ padding: "10px 12px", border: "1px solid #8a8a8a", borderRadius: 8 }}>
              <option value="OUNCES">oz</option>
              <option value="POUNDS">lb</option>
              <option value="GRAMS">g</option>
              <option value="KILOGRAMS">kg</option>
            </select>
          </div>
          <div style={{ fontSize: 13, color: "#616161", marginTop: 6 }}>
            Your store's shipping rates use this to price shipping on the winner's invoice. Leave it empty if you set weights in Shopify.
          </div>
        </div>

        <s-section heading="Auction Schedule">
          <s-stack gap="base">

            <s-text>
              Times are in your store's time zone ({timezone})
            </s-text>

            <s-date-picker
              label="Start Date"
              name="startsAtDate"
              type="single"
              value={startDate}
              defaultValue={startDate}
              disallow="past"
              visibleMonths="1"
              required
              onChange={(event) =>
                setStartDate(
                  event.currentTarget.value,
                )
              }
            />

            <s-stack gap="small">

              <s-text>
                Start Time
              </s-text>

              <s-stack
                direction="inline"
                gap="small"
              >

                <div>
                  <s-button
                    type="button"
                    onClick={() => {
                      const p = getEasternParts(new Date(), timezone);
                      setStartDate(p.date);
                      setStartHour(String(Number(p.hour)));
                      setStartMinute(p.minute);
                      setStartAmPm(p.ampm);
                    }}
                  >
                    Start now
                  </s-button>
                </div>

                <s-select
                  label="Hour"
                  name="startsAtHour"
                  value={startHour}
                  onChange={(event) =>
                    setStartHour(
                      event.currentTarget.value,
                    )
                  }
                >
                  {Array.from(
                    { length: 12 },
                    (_, index) => {
                      const hour =
                        String(index + 1);

                      return (
                        <s-option
                          key={hour}
                          value={hour}
                        >
                          {hour}
                        </s-option>
                      );
                    },
                  )}
                </s-select>

                <s-select
                  label="Minute"
                  name="startsAtMinute"
                  value={startMinute}
                  onChange={(event) =>
                    setStartMinute(
                      event.currentTarget.value,
                    )
                  }
                >
                  {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((minute) => (
                    <s-option
                      key={minute}
                      value={minute}
                    >
                      :{minute}
                    </s-option>
                  ))}
                </s-select>

                <s-select
                  label="AM / PM"
                  name="startsAtAmPm"
                  value={startAmPm}
                  onChange={(event) =>
                    setStartAmPm(
                      event.currentTarget.value,
                    )
                  }
                >
                  <s-option value="AM">
                    AM
                  </s-option>
                  <s-option value="PM">
                    PM
                  </s-option>
                </s-select>

              </s-stack>

            </s-stack>

            <s-select
              label="Auction Length"
              name="durationDays"
              value={duration}
              onChange={(event) =>
                setDuration(
                  event.currentTarget.value,
                )
              }
            >
              {DURATION_OPTIONS.map(
                (option) => (
                  <s-option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </s-option>
                ),
              )}
            </s-select>

            {String(duration).startsWith("m") && (
              <s-banner tone="warning">
                Test auctions are for trying the app. On a live store they never create a winner, an order or an invoice, and nobody can pay for them. For a real sale, choose 24 hours or longer.
              </s-banner>
            )}

            <s-card>
              <s-stack gap="small">
                <s-text>
                  Automatic End Time
                </s-text>

                <s-heading>
                  {calculateEndPreview()}
                </s-heading>

                <s-text>
                  The end time is automatically
                  calculated from the start time
                  and auction length.
                </s-text>
              </s-stack>
            </s-card>

          </s-stack>
        </s-section>
          </>
        )}

        <s-stack
          direction="inline"
          gap="small"
        >
          <s-button
            type="submit"
            variant="primary"
          >
            {isEdit
              ? "Save Auction Changes"
              : "Create Auction"}
          </s-button>

          {isEdit && (
            <s-button
              type="button"
              onClick={onCancel}
            >
              Cancel
            </s-button>
          )}
        </s-stack>

      </s-stack>
    </Form>
  );
}

export default function AuctionsPage() {
  const { auctions, storefrontActivationUrl, timezone, showMenuBanner, blocked = [], insights, planFlags, moreAuctions, embedOff, shippingSettingsUrl, liveBlockUrl, adminBase, settings, removedCount = 0, showRemoved = false } = useLoaderData();
  const paidCount = auctions.filter((a) => a.paymentStatus === "COMPLETED").length;

  // Live admin: refresh bids, high bidders and statuses every 10 seconds while the tab is visible.
  const revalidator = useRevalidator();
  useEffect(() => {
    const hasActive = auctions.some((a) => new Date(a.endsAt).getTime() > Date.now() - 5 * 60_000);
    if (!hasActive) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine !== false && revalidator.state === "idle") revalidator.revalidate();
    }, 10000);
    return () => clearInterval(id);
  }, [revalidator, auctions]);
  const [salesBusy, setSalesBusy] = useState(false);
  const downloadSales = async () => {
    setSalesBusy(true);
    try {
      const res = await fetch("/app/export-sales");
      if (!res.ok) throw new Error("failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hellfire-auctions-sales-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      window.alert("Sorry, the sales report couldn't be downloaded. Please try again.");
    } finally {
      setSalesBusy(false);
    }
  };
  const [backupBusy, setBackupBusy] = useState(false);
  const downloadBackup = async () => {
    setBackupBusy(true);
    try {
      const res = await fetch("/app/backup");
      if (!res.ok) throw new Error("Backup failed");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `hellfire-auctions-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      window.alert("Sorry, the backup couldn't be downloaded. Please try again.");
    } finally {
      setBackupBusy(false);
    }
  };
  const actionData = useActionData();
  const [evSel, setEvSel] = useState([]); // auctions picked for an event, in the order they will end
  useEffect(() => {
    if (actionData?.eventScheduled) setEvSel([]);
  }, [actionData]);

  const [cloneFrom, setCloneFrom] = useState(null);
  const [editingId, setEditingId] =
    useState(null);

  const [formNonce, setFormNonce] = useState(0);
  useEffect(() => {
    if (actionData && (actionData.error || actionData.success)) window.scrollTo({ top: 0, behavior: "smooth" });
    if (actionData?.success) setCloneFrom(null);
    // A successful create (not an edit, and not a message-style result) clears the form for the next listing.
    if (actionData?.success && typeof actionData.success !== "string" && actionData?.mode !== "update") {
      setFormNonce((n) => n + 1);
    }
  }, [actionData]);

  const editingAuction =
    auctions.find(
      (auction) =>
        auction.id === editingId,
    );

  return (
    <s-page heading="Hellfire Auctions">
      {showMenuBanner && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", background: "linear-gradient(90deg,#1a0000,#7a0000,#ff3b30)", color: "#fff", borderRadius: 14, padding: "16px 20px", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{"\u{1F525}"} Add &ldquo;My Auctions&rdquo; to your store menu</div>
            <div style={{ fontSize: 13, opacity: 0.9 }}>One click gives your customers a page showing every auction they&rsquo;re bidding on, winning or outbid.</div>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="add-menu-link" />
            <button type="submit" style={{ border: 0, cursor: "pointer", fontWeight: 800, padding: "10px 18px", borderRadius: 10, background: "#ffd60a", color: "#1a0000" }}>Add it</button>
          </Form>
        </div>
      )}


      {actionData?.error && (
        <s-banner tone="critical">
          {actionData.error}
        </s-banner>
      )}

      {actionData?.success && (
        <s-banner tone="success">
          {typeof actionData.success === "string"
            ? actionData.success
            : actionData.mode === "update"
              ? "Auction updated successfully."
              : "Auction created successfully."}
        </s-banner>
      )}

      <details open style={{ background: "#fff", border: "1px solid #e3e3e3", borderRadius: 12, padding: "14px 18px", marginBottom: 16 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 15 }}>Setup guide (about 10 minutes)</summary>
        <ol style={{ margin: "12px 0 0", paddingLeft: 20, display: "grid", gap: 12, fontSize: 14, lineHeight: 1.5 }}>
          <li>
            <strong>Turn on Hellfire Auctions in your theme.</strong> Click the button below. In the panel that opens on the left, switch <em>Hellfire Auctions Runtime</em> on, then click <em>Save</em> (top right). This adds the live bidding panel to auction product pages and live bid badges to product cards. It works with any theme and changes no theme code. Repeat this for any other theme you publish later.
            <div style={{ marginTop: 8 }}>
              <s-button href={storefrontActivationUrl} target="_top" variant="primary">Open theme editor</s-button>
            </div>
          </li>
          <li>
            <strong>Make sure your store can take payments.</strong> Winners pay through Shopify&rsquo;s own checkout, so a payment method must be active. Check{" "}
            <s-link href={`${adminBase}/settings/payments`} target="_top">Settings, Payments</s-link>. To try a payment without real money, turn on your provider&rsquo;s test mode (on a development store, activate the <em>Bogus Gateway</em>).
          </li>
          <li>
            <strong>Let customers sign in.</strong> Bidding needs a customer account. In{" "}
            <s-link href={`${adminBase}/settings/customer_accounts`} target="_top">Settings, Customer accounts</s-link>{" "}
            make sure sign-in is on and your store shows an account or sign-in link.
          </li>
          <li>
            <strong>Check your shipping rates.</strong> At checkout, winners pick from your store&rsquo;s own shipping options in{" "}
            <s-link href={shippingSettingsUrl} target="_top">Settings, Shipping and delivery</s-link>. If your rates depend on weight, give each auction a weight: there&rsquo;s a field on the create form and a <em>Shipping weight</em> line on every auction card, and you can add or change it at any time. You can also set a <em>Default shipping weight</em> in the app, used whenever you don&rsquo;t enter one. Optional: add a $0.00 rate named <em>Add to my existing order (free)</em>; when a winner picks it, add the item to their earlier order before shipping.
          </li>
          <li>
            <strong>Create your first auction</strong> with the form below: title, description, photos, starting bid, optional reserve price, start time and length. The app creates the product, adds it to a <em>Live Auctions</em> collection, and starts and ends the auction automatically. The winner is invoiced through Shopify when it ends. Tip: a test auction (under 1 hour) never counts toward your monthly limit.
          </li>
          <li>
            <strong>Add &ldquo;My Auctions&rdquo; to your store menu</strong> using the one-click banner (if shown), so customers can see every auction they&rsquo;re bidding on, have won, lost or paid for.
          </li>
          <li>
            <strong>Show your live auctions on any page (optional).</strong> Add the <em>Live Auctions</em> block, for example to your home page. It needs a newer (Online Store 2.0) theme; the bidding panel and card badges work on any theme. It lists only running auctions, soonest-ending first, and matches your theme&rsquo;s fonts and colors.{" "}
            <s-link href={liveBlockUrl} target="_top">Add the Live Auctions block to my home page</s-link>
          </li>
          <li>
            <strong>Languages and currencies (optional).</strong> The bidding panel, product-card badges, Live Auctions block, My Auctions page and buyer emails appear in the shopper's language (Spanish, French, German, Portuguese, Italian or Dutch) whenever they browse your store in it; other languages show English for now. To offer a language, add and publish it in{" "}
            <s-link href={`${adminBase}/settings/languages`} target="_top">Settings, Languages</s-link>. If you sell in more than one currency, bids are always placed in your store&rsquo;s currency and shoppers also see an approximate amount in theirs.
          </li>
          <li>
            <strong>Test it.</strong> Open the auction on your storefront, sign in as a customer and place a bid. When it ends, open the winner&rsquo;s invoice and pay it (in test mode) to see the whole flow. Optional: upgrade on <em>Plans &amp; upgrades</em> for outbid and &ldquo;1 hour left&rdquo; emails.
          </li>
        </ol>
        <div style={{ marginTop: 14, fontSize: 14, lineHeight: 1.5 }}>
          <strong>Good to know</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 20, display: "grid", gap: 6 }}>
            <li><strong>The $99,999 price in your product list</strong> is a placeholder so nobody can buy an auction item outside the auction. Shoppers never see it, and the winner always pays exactly their winning bid.</li>
            <li><strong>Unpaid winners</strong> get 4 days to pay, with reminders. After that the app offers the item to the next bidder for you (you can turn this off under <em>Unpaid winners</em>), counts the unpaid sale against that bidder, and blocks anyone who reaches your limit (2 unpaid sales by default; you can change or turn this off under <em>Unpaid winners</em>). You can still send a reminder, offer the item yourself, or cancel the sale from any auction card.</li>
            <li><strong>Paid items</strong> are archived from your store automatically. Use <em>Clear all paid</em> above your auctions to tidy this list; nothing is deleted.</li>
            <li><strong>Unsold auctions</strong> are taken off your store about 10 minutes after they end. <em>Relist</em> puts them back.</li>
            <li><strong>Auction events:</strong> create several auctions, tick <em>Add to an auction event</em> on the upcoming ones, then schedule them all to start together and end one after another (for example, every 8 minutes).</li>
            <li><strong>Bulk creation:</strong> open <em>Create many auctions from a spreadsheet (CSV)</em> to upload a list, schedule the whole batch as an event, repeat it every week, and relist unsold items automatically.</li>
            <li><strong>Need help?</strong> The <s-link href="https://hellfire-auctions.onrender.com/help" target="_blank">Help center</s-link> has setup steps and troubleshooting, or email support@hellfireauctions.com.</li>
          </ul>
        </div>
      </details>

      <s-section
        heading={
          editingAuction
            ? `Edit Auction — ${editingAuction.title}`
            : "Create Auction"
        }
      >
        {editingAuction ? (
          <AuctionForm
            key={editingAuction.id}
            auction={editingAuction}
            timezone={timezone}
            onCancel={() =>
              setEditingId(null)
            }
          />
        ) : (
          <>
            {cloneFrom && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", background: "#f1f8f5", border: "1px solid #b7dfc9", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                <span>Selling similar to <strong>{cloneFrom.title}</strong>. Details are filled in; change anything you like.</span>
                <s-button type="button" variant="tertiary" onClick={() => setCloneFrom(null)}>Clear</s-button>
              </div>
            )}
            <AuctionForm key={`${cloneFrom?.id || "new"}-${formNonce}`} timezone={timezone} prefill={cloneFrom} allowAutoExtend={Boolean(planFlags?.autoExtend)} />
        <BulkImport timezone={timezone} />
          </>
        )}
      </s-section>

      <s-section heading="Who can bid">
        <Form method="post" style={{ display: "grid", gap: 12, maxWidth: 680 }}>
          <input type="hidden" name="intent" value="save-bidder-rule" />
          <span style={{ fontSize: 14 }}>
            Everyone who is signed in can bid unless you choose otherwise. To stop one specific person, open an auction, find them in its bidders list and click Block. Bidders are also blocked automatically after 2 unpaid sales (you can change that under Unpaid winners). Or limit bidding to a group below; a shopper who isn&rsquo;t eligible sees a clear message and can contact you to be approved. Bidders you have blocked stay blocked.
          </span>
          <select name="bidderRule" defaultValue={settings?.bidderRule || "ANYONE"} aria-label="Who can bid" style={{ padding: "10px 12px", border: "1px solid #8a8a8a", borderRadius: 8, maxWidth: 420 }}>
            {Object.entries(BIDDER_RULES).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label style={{ display: "grid", gap: 4, maxWidth: 420 }}>
            <strong>Approval tag (used with &ldquo;approved with a tag&rdquo;)</strong>
            <input name="approvedTag" defaultValue={settings?.approvedTag || "bidder-approved"} maxLength={40} style={{ padding: "10px 12px", border: "1px solid #8a8a8a", borderRadius: 8 }} />
          </label>
          <span style={{ fontSize: 13, color: "#616161" }}>
            To approve someone: open the customer in Shopify (Customers), add this tag to them and save. Changes can take up to a minute to reach a shopper who has already tried to bid.
          </span>
          <div><s-button type="submit" variant="primary">Save</s-button></div>
        </Form>
      </s-section>

      <s-section heading="Default shipping weight">
        <div style={{ display: "grid", gap: 12, maxWidth: 680 }}>
          <span style={{ fontSize: 14 }}>
            Used for any new auction where you don&rsquo;t enter a weight, so your store&rsquo;s weight-based shipping rates always have something to work with. You can still set a different weight on any auction.
          </span>
          <Form method="post" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="hidden" name="intent" value="save-default-weight" />
            <input name="defaultWeight" type="number" min="0" step="0.01" defaultValue={settings?.defaultWeight ?? ""} placeholder="e.g. 8" aria-label="Default shipping weight" style={{ padding: "10px 12px", border: "1px solid #8a8a8a", borderRadius: 8, width: 120 }} />
            <select name="defaultWeightUnit" defaultValue={settings?.defaultWeightUnit || "OUNCES"} aria-label="Weight unit" style={{ padding: "10px 12px", border: "1px solid #8a8a8a", borderRadius: 8 }}>
              <option value="OUNCES">oz</option>
              <option value="POUNDS">lb</option>
              <option value="GRAMS">g</option>
              <option value="KILOGRAMS">kg</option>
            </select>
            <s-button type="submit" variant="primary">Save</s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="apply-default-weight" />
            <s-button type="submit" variant="secondary">Apply it to my existing auctions that have no weight</s-button>
          </Form>
        </div>
      </s-section>

      <s-section heading="Unpaid winners">
        <Form method="post" style={{ display: "grid", gap: 14, maxWidth: 680 }}>
          <input type="hidden" name="intent" value="save-settings" />
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <input type="checkbox" name="autoOfferNext" defaultChecked={settings?.autoOfferNext !== false} style={{ marginTop: 4, width: 18, height: 18 }} />
            <span>
              <strong>Offer the item to the next bidder automatically</strong>
              <br />
              <span style={{ fontSize: 13, color: "#616161" }}>
                If a winner hasn&rsquo;t paid after 4 days (and two reminders), the item is offered to the next-highest bidder at their own maximum bid. This happens once per auction, and you get an email when it does.
              </span>
            </span>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <strong>Block bidders after unpaid sales</strong>
            <select name="strikeLimit" defaultValue={String(settings?.strikeLimit ?? 2)} style={{ padding: "10px 12px", border: "1px solid #8a8a8a", borderRadius: 8, maxWidth: 320 }}>
              <option value="0">Never block automatically</option>
              <option value="1">After 1 unpaid sale</option>
              <option value="2">After 2 unpaid sales (default)</option>
              <option value="3">After 3 unpaid sales</option>
              <option value="5">After 5 unpaid sales</option>
            </select>
            <span style={{ fontSize: 13, color: "#616161" }}>
              A sale counts as unpaid when a winner doesn&rsquo;t pay within 4 days, or when you offer the item to the next bidder yourself. Blocked bidders can&rsquo;t place bids on your auctions; you can unblock anyone in the Blocked bidders list.
            </span>
          </label>
          <div><s-button type="submit" variant="primary">Save</s-button></div>
        </Form>
      </s-section>

      <s-section heading="Auctions">
        {!showRemoved && evSel.length > 0 && (
          <Form method="post" style={{ background: "#f6f6f7", border: "1px solid #c9cccf", borderRadius: 12, padding: 16, margin: "0 0 16px", display: "grid", gap: 12 }}>
            <input type="hidden" name="intent" value="schedule-event" />
            {evSel.map((id) => <input key={id} type="hidden" name="auctionIds" value={id} />)}
            <strong>Auction event: {evSel.length} auction{evSel.length === 1 ? "" : "s"} selected</strong>
            <ol style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 6, fontSize: 14 }}>
              {evSel.map((id, i) => (
                <li key={id}>
                  {auctions.find((a) => a.id === id)?.title || id}{" "}
                  <button type="button" disabled={i === 0} aria-label="Move earlier" onClick={() => setEvSel((s) => { const c = [...s]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })}>&uarr;</button>{" "}
                  <button type="button" disabled={i === evSel.length - 1} aria-label="Move later" onClick={() => setEvSel((s) => { const c = [...s]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })}>&darr;</button>{" "}
                  <button type="button" aria-label="Remove from the event" onClick={() => setEvSel((s) => s.filter((x) => x !== id))}>&times;</button>
                </li>
              ))}
            </ol>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ display: "grid", gap: 4 }}>
                <strong>All auctions start</strong>
                <input type="datetime-local" name="eventStart" required style={{ padding: "8px 10px", border: "1px solid #8a8a8a", borderRadius: 8 }} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <strong>First auction ends</strong>
                <input type="datetime-local" name="eventFirstEnd" required style={{ padding: "8px 10px", border: "1px solid #8a8a8a", borderRadius: 8 }} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <strong>Minutes between endings</strong>
                <input type="number" name="eventGap" min="1" max="1440" defaultValue="8" required style={{ padding: "8px 10px", border: "1px solid #8a8a8a", borderRadius: 8, width: 120 }} />
              </label>
            </div>
            <span style={{ fontSize: 13, color: "#616161" }}>
              Times are in your store&rsquo;s time zone ({timezone}). Auctions end one after another in the order shown. Only auctions that haven&rsquo;t started can be added.
            </span>
            <div style={{ display: "flex", gap: 10 }}>
              <s-button type="submit" variant="primary">Schedule event</s-button>
              <s-button type="button" variant="secondary" onClick={() => setEvSel([])}>Clear selection</s-button>
            </div>
          </Form>
        )}
        {(paidCount > 0 || removedCount > 0 || showRemoved) && (
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", margin: "0 0 14px" }}>
            {showRemoved && <strong>Removed auctions</strong>}
            {!showRemoved && paidCount > 0 && (
              <Form method="post" onSubmit={(e) => { if (!window.confirm("Remove all paid auctions from this list? They stay in your records and insights, and you can bring them back from Show removed.")) e.preventDefault(); }}>
                <input type="hidden" name="intent" value="hide-paid" />
                <s-button type="submit" variant="secondary">Clear all paid ({paidCount})</s-button>
              </Form>
            )}
            {showRemoved ? (
              <s-link href="/app">Back to your auctions</s-link>
            ) : removedCount > 0 ? (
              <s-link href="/app?removed=1">Show removed ({removedCount})</s-link>
            ) : null}
          </div>
        )}

        {auctions.length === 0 ? (
          <s-empty-state heading="No auctions yet">
            Create your first Hellfire auction above.
          </s-empty-state>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 16 }}>
            {auctions.map((auction) => {
              const now = Date.now();
              const state =
                now < new Date(auction.startsAt).getTime()
                  ? "UPCOMING"
                  : now >= new Date(auction.endsAt).getTime()
                    ? "ENDED"
                    : "LIVE";
              const stateColor = { LIVE: "#d72c0d", UPCOMING: "#b98900", ENDED: "#616161" }[state];
              const reserveMet =
                auction.reservePrice == null || Number(auction.currentBid) >= Number(auction.reservePrice);
              return (
                <div
                  key={auction.id}
                  style={{ border: "1px solid #e3e3e3", borderRadius: 12, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" }}
                >
                  {auction.imageUrl ? (
                    <img src={auction.imageUrl} alt={auction.title} style={{ width: "100%", height: 150, objectFit: "cover", display: "block" }} />
                  ) : (
                    <div style={{ height: 150, background: "linear-gradient(135deg,#3d0000,#ff3b30)" }} />
                  )}
                  <div style={{ padding: "12px 14px", display: "grid", gap: 6, flexGrow: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <strong style={{ fontSize: 15, lineHeight: 1.3 }}>{auction.title}</strong>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: stateColor, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
                        {auction.status === "CANCELLED" ? "ENDED EARLY" : state === "UPCOMING" ? "SCHEDULED" : state}
                      </span>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "#d72c0d" }}>
                      ${Number(auction.bidCount > 0 ? auction.currentBid : auction.startingBid).toFixed(2)}
                      <span style={{ fontSize: 12, fontWeight: 500, color: "#616161" }}>
                        {" "}{auction.bidCount > 0 ? "current" : "starting"} · {auction.bidCount} bid{auction.bidCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "#303030" }}>
                      {auction.highBidder ? (
                        <>
                          <div>
                            <strong>{state === "ENDED" ? "Winner" : "High bidder"}:</strong>{" "}
                            <a href={`shopify://admin/customers/${auction.highBidder.customerId}`} target="_top" style={{ color: "#005bd3" }}>
                              {auction.highBidder.name}
                            </a>
                          </div>
                          {auction.highBidder.email && <div style={{ color: "#616161", wordBreak: "break-all" }}>{auction.highBidder.email}</div>}
                        </>
                      ) : (
                        <span style={{ color: "#616161" }}>No bids yet</span>
                      )}
                    </div>
                    {auction.reservePrice != null && (
                      <div style={{ fontSize: 12, color: reserveMet ? "#008060" : "#b98900" }}>
                        Reserve ${Number(auction.reservePrice).toFixed(2)} {reserveMet ? "met" : "not met"}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: "#616161" }}>
                      {state === "UPCOMING" ? "Starts " : state === "LIVE" ? "Ends " : "Ended "}
                      {formatEastern(new Date(state === "UPCOMING" ? auction.startsAt : auction.endsAt), timezone)}
                    </div>
                    {state === "ENDED" && auction.winnerId && ["COMPLETED", "OPEN", "INVOICE_SENT"].includes(auction.paymentStatus) && (
                      <div style={{ fontSize: 13 }}>
                        {auction.paymentStatus === "COMPLETED" ? (
                          <strong style={{ color: "#008060" }}>Paid {"\u2714"}</strong>
                        ) : (
                          <>
                            <strong style={{ color: Date.now() > new Date(auction.payDeadline).getTime() ? "#d72c0d" : "#b98900" }}>
                              {Date.now() > new Date(auction.payDeadline).getTime() ? "Unpaid \u2014 deadline passed" : "Awaiting payment"}
                            </strong>
                            <div style={{ color: "#616161" }}>Due {formatEastern(new Date(auction.payDeadline), timezone)}</div>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                              <Form method="post">
                                <input type="hidden" name="intent" value="remind-winner" />
                                <input type="hidden" name="auctionId" value={auction.id} />
                                <s-button type="submit" variant="tertiary">Send reminder</s-button>
                              </Form>
                              {auction.winnerUnpaidCount >= 2 && auction.winnerDraftCount >= 2 && (
                                <Form method="post" onSubmit={(e) => { if (!window.confirm("Combine all of this buyer's unpaid wins into one invoice? Their separate invoices are cancelled and they get one new link by email.")) e.preventDefault(); }}>
                                  <input type="hidden" name="intent" value="combine-wins" />
                                  <input type="hidden" name="auctionId" value={auction.id} />
                                  <s-button type="submit" variant="tertiary">Combine this buyer's wins</s-button>
                                </Form>
                              )}
                              {auction.winnerUnpaidCount >= 2 && auction.winnerDraftCount === 1 && (
                                <div style={{ fontSize: 12, color: "#616161", alignSelf: "center" }}>Combined invoice ({auction.winnerUnpaidCount} items)</div>
                              )}
                              {auction.hasOtherBidders && (
                                <Form method="post" onSubmit={(e) => { if (!window.confirm("Offer this item to the next-highest bidder at their bid? The current winner's invoice will be cancelled.")) e.preventDefault(); }}>
                                  <input type="hidden" name="intent" value="offer-next" />
                                  <input type="hidden" name="auctionId" value={auction.id} />
                                  <s-button type="submit" variant="tertiary">Offer to next bidder</s-button>
                                </Form>
                              )}
                              <Form method="post" onSubmit={(e) => { if (!window.confirm("Cancel this sale? The winner's invoice is cancelled and you can relist the item. The bidder is NOT blocked.")) e.preventDefault(); }}>
                                <input type="hidden" name="intent" value="cancel-sale" />
                                <input type="hidden" name="auctionId" value={auction.id} />
                                <s-button type="submit" tone="critical" variant="tertiary">Cancel sale</s-button>
                              </Form>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    {auction.isTest && (
                      <div style={{ fontSize: 12, color: "#b98900", fontWeight: 600 }}>
                        Test auction: no order or invoice is created on live stores
                      </div>
                    )}
                    {state === "UPCOMING" && !showRemoved && auction.bidCount === 0 && (
                      <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="checkbox"
                          checked={evSel.includes(auction.id)}
                          onChange={(e) => setEvSel((s) => (e.target.checked ? [...s, auction.id] : s.filter((x) => x !== auction.id)))}
                        />
                        Add to an auction event
                      </label>
                    )}
                    {state !== "ENDED" && auction.autoRelistLeft > 0 && (
                      <div style={{ fontSize: 12, color: "#616161" }}>Relists automatically if it doesn&rsquo;t sell ({auction.autoRelistLeft} more time{auction.autoRelistLeft === 1 ? "" : "s"}).</div>
                    )}
                    {state === "ENDED" && !auction.winnerId && auction.status !== "CANCELLED" && auction.autoRelistLeft > 0 && (
                      <div style={{ fontSize: 12, color: "#616161" }}>Unsold: relisting automatically in a moment.</div>
                    )}
                    {state === "ENDED" && !auction.winnerId && auction.status !== "CANCELLED" && !(auction.autoRelistLeft > 0) && (
                      <div style={{ fontSize: 12, color: "#616161" }}>Unsold: taken off your store a few minutes after it ends. Relist to put it back.</div>
                    )}
                    {!showRemoved && !(state === "ENDED" && (!auction.winnerId || auction.paymentStatus === "COMPLETED")) && (
                      <details style={{ fontSize: 13 }}>
                        <summary style={{ cursor: "pointer", color: auction.weight ? "#303030" : "#8a5a00" }}>
                          {auction.weight ? `Shipping weight: ${auction.weight.value} ${WEIGHT_LABELS[auction.weight.unit] || ""}` : "No shipping weight yet. Add one"}
                        </summary>
                        <Form method="post" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                          <input type="hidden" name="intent" value="set-weight" />
                          <input type="hidden" name="auctionId" value={auction.id} />
                          <input name="weightValue" type="number" min="0" step="0.01" required defaultValue={auction.weight?.value ?? ""} placeholder="e.g. 8" style={{ padding: "6px 8px", border: "1px solid #8a8a8a", borderRadius: 6, width: 80 }} />
                          <select name="weightUnit" defaultValue={auction.weight?.unit || "OUNCES"} style={{ padding: "6px 8px", border: "1px solid #8a8a8a", borderRadius: 6 }}>
                            <option value="OUNCES">oz</option>
                            <option value="POUNDS">lb</option>
                            <option value="GRAMS">g</option>
                            <option value="KILOGRAMS">kg</option>
                          </select>
                          <s-button type="submit" variant="secondary">Save</s-button>
                        </Form>
                      </details>
                    )}
                    {state === "ENDED" && auction.winnerId && auction.winnerStrikes > 0 && auction.paymentStatus !== "COMPLETED" && (
                      <div style={{ fontSize: 12, color: "#b42318", fontWeight: 600 }}>This winner has {auction.winnerStrikes} earlier unpaid sale{auction.winnerStrikes === 1 ? "" : "s"} on record.</div>
                    )}
                    {auction.autoExtend && (
                      <div style={{ fontSize: 12, color: "#616161" }}>Anti-sniping on</div>
                    )}
                    {auction.bidders?.length > 0 && (
                      <details style={{ fontSize: 13 }}>
                        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Bidders ({auction.bidders.length})</summary>
                        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                          {auction.bidders.map((b) => (
                            <div key={b.customerId} style={{ borderTop: "1px solid #eee", paddingTop: 6 }}>
                              <div>
                                <a href={`shopify://admin/customers/${b.customerId}`} target="_top" style={{ color: "#005bd3" }}>{b.name}</a>
                                {b.isLeader && <strong style={{ color: "#008060" }}> {"\u00B7"} leading</strong>}
                                {b.isStoreEmail && <strong style={{ color: "#d72c0d" }}> {"\u00B7"} your store's email</strong>}
                              </div>
                              {b.email && <div style={{ color: "#616161", wordBreak: "break-all" }}>{b.email}</div>}
                              <div style={{ color: "#616161" }}>Bid: ${b.amount.toFixed(2)}</div>
                              <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                                  {state !== "ENDED" && (
                                  <Form method="post" onSubmit={(e) => { if (!window.confirm("Remove this bidder's bid from this auction? The price and leader will recalculate.")) e.preventDefault(); }}>
                                    <input type="hidden" name="intent" value="remove-bid" />
                                    <input type="hidden" name="auctionId" value={auction.id} />
                                    <input type="hidden" name="customerId" value={b.customerId} />
                                    <s-button type="submit" tone="critical" variant="tertiary">Remove bid</s-button>
                                  </Form>
                                  )}
                                  <Form method="post" onSubmit={(e) => { if (!window.confirm("Block " + b.name + "?\n\nThey won't be able to bid on any of your auctions, and any live bids from them are removed.\n\nYou can undo this any time from the Blocked bidders list at the bottom of this page.")) e.preventDefault(); }}>
                                    <input type="hidden" name="intent" value="block-bidder" />
                                    <input type="hidden" name="customerId" value={b.customerId} />
                                    <s-button type="submit" tone="critical" variant="tertiary">Block bidder</s-button>
                                  </Form>
                                </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    <div style={{ marginTop: "auto", paddingTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <s-button type="button" onClick={() => setEditingId(auction.id)}>
                        Edit
                      </s-button>
                      <s-button
                        type="button"
                        onClick={() => {
                          setCloneFrom(auction);
                          setEditingId(null);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        Sell similar
                      </s-button>
                      {showRemoved ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="unhide-auction" />
                          <input type="hidden" name="auctionId" value={auction.id} />
                          <s-button type="submit" variant="tertiary">Restore</s-button>
                        </Form>
                      ) : auction.paymentStatus === "COMPLETED" ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="hide-auction" />
                          <input type="hidden" name="auctionId" value={auction.id} />
                          <s-button type="submit" variant="tertiary">Remove from list</s-button>
                        </Form>
                      ) : null}
                      {state !== "ENDED" && auction.status !== "CANCELLED" && (
                        <Form method="post" onSubmit={(e) => { if (!window.confirm("End this auction now WITHOUT a sale? Nobody will be invoiced and the product will be hidden. Use this if there's a problem with the item.")) e.preventDefault(); }}>
                          <input type="hidden" name="intent" value="end" />
                          <input type="hidden" name="auctionId" value={auction.id} />
                          <s-button type="submit" tone="critical">End now</s-button>
                        </Form>
                      )}
                      {(state === "ENDED" || auction.status === "CANCELLED") && !auction.winnerId && (
                        <Form method="post" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input type="hidden" name="intent" value="relist" />
                          <input type="hidden" name="auctionId" value={auction.id} />
                          <select name="durationDays" defaultValue="7" aria-label="Relist length" style={{ padding: "5px 6px", borderRadius: 8, border: "1px solid #c9c9c9" }}>
                            {DURATION_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                          <s-button type="submit" variant="primary">Relist</s-button>
                        </Form>
                      )}
                      {(state === "ENDED" || auction.status === "CANCELLED") && (
                        <Form method="post" onSubmit={(e) => { const unpaid = ["OPEN", "INVOICE_SENT"].includes(auction.paymentStatus); const msg = unpaid ? "This auction's winner hasn't paid yet. Deleting cancels their invoice and removes the item from your store. Delete anyway? This can't be undone." : "Delete this auction permanently? Its product will also be deleted from your store (unless a relisted auction still uses it). This can't be undone."; if (!window.confirm(msg)) { e.preventDefault(); return; } e.currentTarget.elements.force.value = unpaid ? "1" : ""; }}>
                                    <input type="hidden" name="force" value="" />
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="auctionId" value={auction.id} />
                          <s-button type="submit" tone="critical" variant="tertiary">Delete</s-button>
                        </Form>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </s-section>

      {embedOff && (
        <s-banner tone="critical" heading="Your storefront isn't showing your live auction">
          Shoppers can't bid until the app embed is on. This usually happens after publishing a new theme.{" "}
          <s-link href={storefrontActivationUrl} target="_top">Open the theme editor</s-link>, switch on <em>Hellfire Auctions Runtime</em>, and click Save.
        </s-banner>
      )}

      {moreAuctions && (
        <s-text>
          Showing your 60 most recent auctions. <s-link href="/app?all=1">Show all</s-link>
        </s-text>
      )}

      <s-section heading="Insights (last 30 days)">
        {!planFlags?.insights ? (
          <s-text>
            Sales insights (sell-through, average price, most active bidders) are part of the Inferno plan.{" "}
            <s-link href="/app/plans">See plans</s-link>
          </s-text>
        ) : !insights || insights.endedCount === 0 ? (
          <s-text>Your numbers appear here after your first auction ends.</s-text>
        ) : (
          <s-stack gap="base">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
              {[
                ["Auctions ended", String(insights.endedCount)],
                ["Sold", `${insights.soldCount} (${insights.sellThrough}%)`],
                ["Sold value", `${insights.soldValue.toFixed(2)}`],
                ["Average price", insights.soldCount ? `${insights.avgPrice.toFixed(2)}` : "\u2014"],
                ["Bids per auction", insights.avgBids.toFixed(1)],
                ["Live right now", String(insights.liveNow)],
              ].map(([label, value]) => (
                <div key={label} style={{ border: "1px solid #e3e3e3", borderRadius: 12, padding: "12px 14px", background: "#fff" }}>
                  <div style={{ fontSize: 12, color: "#616161" }}>{label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{value}</div>
                </div>
              ))}
            </div>
            {insights.best && (
              <s-text>
                Best sale: <strong>{insights.best.title}</strong> for <strong>${insights.best.price.toFixed(2)}</strong>
              </s-text>
            )}
            {insights.topBidders.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Most active bidders (all time)</div>
                <div style={{ display: "grid", gap: 4, fontSize: 14 }}>
                  {insights.topBidders.map((b) => (
                    <div key={b.customerId}>
                      <a href={`shopify://admin/customers/${b.customerId}`} target="_top" style={{ color: "#005bd3" }}>{b.name}</a>
                      <span style={{ color: "#616161" }}> {"\u00B7"} {b.auctions} auction{b.auctions === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </s-stack>
        )}
      </s-section>

      {blocked.length > 0 && (
        <s-section heading="Blocked bidders">
          <s-stack gap="small">
            {blocked.map((b) => (
              <div key={b.customerId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <a href={`shopify://admin/customers/${b.customerId}`} target="_top" style={{ color: "#005bd3" }}>{b.name}</a>
                  {b.email && <span style={{ color: "#616161" }}> {"\u00B7"} {b.email}</span>}
                </div>
                <Form method="post">
                  <input type="hidden" name="intent" value="unblock-bidder" />
                  <input type="hidden" name="customerId" value={b.customerId} />
                  <s-button type="submit" variant="tertiary">Unblock</s-button>
                </Form>
              </div>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading="Backup">
        <s-stack gap="small">
          <s-text>Download a copy of every auction and bid in your store, any time.</s-text>
          <s-button type="button" onClick={downloadBackup} disabled={backupBusy}>
            {backupBusy ? "Preparing backup..." : "Download backup"}
          </s-button>
          <s-button type="button" variant="secondary" onClick={downloadSales} disabled={salesBusy}>
            {salesBusy ? "Preparing report..." : "Download sales report (CSV)"}
          </s-button>
        </s-stack>
      </s-section>

    </s-page>
  );
}

// Every admin change (create, edit, relist, cancel) wakes the auction engine to re-plan its schedule.
export const action = async (args) => {
  const result = await actionImpl(args);
  wakeWorker();
  return result;
};
