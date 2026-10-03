import crypto from "node:crypto";
import { useActionData, useLoaderData, useRevalidator, Form } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveProxyBids } from "../bidding.server";
import { canCreateAuction } from "../plans.server";
import { wakeWorker, offerToNextBidder, remindWinnerNow, cancelUnpaidSale } from "../auction-worker.server";

const DURATION_OPTIONS = [
  { value: "1", label: "24 Hours" },
  { value: "3", label: "3 Days" },
  { value: "5", label: "5 Days" },
  { value: "7", label: "7 Days" },
  { value: "14", label: "14 Days" },
  { value: "30", label: "30 Days" },
  { value: "m10", label: "Test \u2014 10 minutes" },
  { value: "m5", label: "Test \u2014 5 minutes" },
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
  const locationId = json?.data?.locations?.nodes?.[0]?.id;

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

  const auctions = await prisma.auction.findMany({
    where: {
      shop: session.shop,
    },
    orderBy: {
      createdAt: "desc",
    },
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

  return { auctions: auctionsWithLeaders, storefrontActivationUrl, timezone, showMenuBanner, blocked, insights };
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

  if (["remind-winner", "offer-next", "cancel-sale"].includes(intent)) {
    const id = formData.get("auctionId")?.toString() || "";
    try {
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
          return { error: "The winner hasn't paid their invoice yet. Deleting now would break their checkout link, so wait until it's paid." };
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

  const title =
    formData.get("title")?.toString().trim();

  const description =
    formData.get("description")?.toString().trim() || "";

  const startingBid =
    Math.round(Number(formData.get("startingBid")) * 100) / 100;

  const reservePriceValue =
    formData.get("reservePrice");

  const startsAtDate =
    formData.get("startsAtDate")?.toString();

  const startsAtHour =
    formData.get("startsAtHour")?.toString();

  const startsAtMinute =
    formData.get("startsAtMinute")?.toString();

  const startsAtAmPm =
    formData.get("startsAtAmPm")?.toString();

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
    !isDurationOption(durationValue)
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

  const endsAt = new Date(
    startsAt.getTime() +
      durationMs(durationValue),
  );

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
  const useCopiedPhoto = !hasUpload && /^https:\/\/cdn\.shopify\.com\//.test(cloneImageUrl);

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
        startsAt,
        endsAt,
        status: startsAt > new Date() ? "UPCOMING" : (new Date() < endsAt ? "LIVE" : "ENDED"),
      },
    });

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
              This auction has started, so the title is locked. Like eBay, you can add to the description (it's added below the original, with the date) and add photos.
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
                    <img key={src} src={src} alt={`Photo ${i + 1}`} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: i === 0 ? "3px solid #008060" : "1px solid #ccc" }} />
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
  const { auctions, storefrontActivationUrl, timezone, showMenuBanner, blocked = [], insights } = useLoaderData();

  // Live admin: refresh bids, high bidders and statuses every 10 seconds while the tab is visible.
  const revalidator = useRevalidator();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, 10000);
    return () => clearInterval(id);
  }, [revalidator]);
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

  const [cloneFrom, setCloneFrom] = useState(null);
  const [editingId, setEditingId] =
    useState(null);

  useEffect(() => {
    if (actionData?.success) setCloneFrom(null);
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
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 15 }}>Setup guide (4 steps, about 3 minutes)</summary>
        <ol style={{ margin: "12px 0 0", paddingLeft: 20, display: "grid", gap: 12, fontSize: 14, lineHeight: 1.5 }}>
          <li>
            <strong>Turn on Hellfire Auctions in your theme.</strong> Click the button below. In the panel that opens on the left, switch <em>Hellfire Auctions Runtime</em> on, then click <em>Save</em> (top right). This adds the live bidding panel to auction product pages and live bid badges to product cards. It works with any theme and changes no theme code. Repeat this for any other theme you publish later.
            <div style={{ marginTop: 8 }}>
              <s-button href={storefrontActivationUrl} target="_top" variant="primary">Open theme editor</s-button>
            </div>
          </li>
          <li>
            <strong>Create your first auction</strong> with the form below: title, description, image, starting bid, optional reserve price, start time and length. The app creates the product, adds it to a <em>Live Auctions</em> collection, and starts and ends the auction automatically. The winner is invoiced through Shopify when it ends.
          </li>
          <li>
            <strong>Add &ldquo;My Auctions&rdquo; to your store menu</strong> using the one-click banner (if shown) so customers can see every auction they&rsquo;re bidding on, winning or outbid.
          </li>
          <li>
            <strong>Test it.</strong> Open the auction on your storefront, sign in as a customer and place a bid. Bidding requires a customer account. Optional: upgrade on <em>Plans &amp; upgrades</em> for outbid and &ldquo;1 hour left&rdquo; emails.
          </li>
          <li>
            <strong>About the $99,999 price in your Shopify product list.</strong> Auction items are saved with a placeholder price so nobody can buy them outside the auction. It is never shown to shoppers on auction pages, and the winner always pays exactly their winning bid.
          </li>
        </ol>
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
            <AuctionForm key={cloneFrom?.id || "new"} timezone={timezone} prefill={cloneFrom} />
          </>
        )}
      </s-section>

      <s-section heading="Auctions">

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
                              {auction.hasOtherBidders && (
                                <Form method="post" onSubmit={(e) => { if (!window.confirm("Offer this item to the next-highest bidder at their bid? The current winner's invoice will be cancelled.")) e.preventDefault(); }}>
                                  <input type="hidden" name="intent" value="offer-next" />
                                  <input type="hidden" name="auctionId" value={auction.id} />
                                  <s-button type="submit" variant="tertiary">Offer to next bidder</s-button>
                                </Form>
                              )}
                              <Form method="post" onSubmit={(e) => { if (!window.confirm("Cancel this sale? The winner's invoice is cancelled and you can relist the item.")) e.preventDefault(); }}>
                                <input type="hidden" name="intent" value="cancel-sale" />
                                <input type="hidden" name="auctionId" value={auction.id} />
                                <s-button type="submit" tone="critical" variant="tertiary">Cancel sale</s-button>
                              </Form>
                            </div>
                          </>
                        )}
                      </div>
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
                              </div>
                              {b.email && <div style={{ color: "#616161", wordBreak: "break-all" }}>{b.email}</div>}
                              <div style={{ color: "#616161" }}>Bid: ${b.amount.toFixed(2)}</div>
                              {state !== "ENDED" && (
                                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                                  <Form method="post" onSubmit={(e) => { if (!window.confirm("Remove this bidder's bid from this auction? The price and leader will recalculate.")) e.preventDefault(); }}>
                                    <input type="hidden" name="intent" value="remove-bid" />
                                    <input type="hidden" name="auctionId" value={auction.id} />
                                    <input type="hidden" name="customerId" value={b.customerId} />
                                    <s-button type="submit" tone="critical" variant="tertiary">Remove bid</s-button>
                                  </Form>
                                  <Form method="post" onSubmit={(e) => { if (!window.confirm("Block this bidder? Their live bids in all your auctions are removed and they can't bid again until you unblock them.")) e.preventDefault(); }}>
                                    <input type="hidden" name="intent" value="block-bidder" />
                                    <input type="hidden" name="customerId" value={b.customerId} />
                                    <s-button type="submit" tone="critical" variant="tertiary">Block bidder</s-button>
                                  </Form>
                                </div>
                              )}
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
                        <Form method="post" onSubmit={(e) => { if (!window.confirm("Delete this auction permanently? Its product will also be deleted from your store (unless a relisted auction still uses it). This can't be undone.")) e.preventDefault(); }}>
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

      <s-section heading="Insights (last 30 days)">
        {!insights || insights.endedCount === 0 ? (
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
