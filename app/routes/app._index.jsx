import crypto from "node:crypto";
import { useActionData, useLoaderData, Form } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { canCreateAuction } from "../plans.server";
import { wakeWorker } from "../auction-worker.server";

const DURATION_OPTIONS = [
  { value: "1", label: "24 Hours" },
  { value: "3", label: "3 Days" },
  { value: "5", label: "5 Days" },
  { value: "7", label: "7 Days" },
  { value: "14", label: "14 Days" },
  { value: "30", label: "30 Days" },
];

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
    },
  });

  // Leading bidder for every auction (merchant-only view).
  const ids = auctions.map((a) => a.id);
  const bids = ids.length
    ? await prisma.bid.findMany({
        where: { auctionId: { in: ids } },
        orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
        select: { auctionId: true, bidderId: true },
      })
    : [];
  const leaders = new Map();
  for (const bid of bids) if (!leaders.has(bid.auctionId)) leaders.set(bid.auctionId, bid);

  const customerIds = [...new Set([...leaders.values()].map((b) => String(b.bidderId)))];
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

  const auctionsWithLeaders = auctions.map((auction) => {
    const lead = leaders.get(auction.id);
    const customer = lead ? customers.get(String(lead.bidderId)) : null;
    return {
      ...auction,
      highBidder: lead
        ? {
            customerId: String(lead.bidderId),
            name: customer?.displayName || customer?.email || `Customer ${lead.bidderId}`,
            email: customer?.email || null,
          }
        : null,
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

  return { auctions: auctionsWithLeaders, storefrontActivationUrl, timezone, showMenuBanner };
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

  if (intent === "cancel" || intent === "relist") {
    const target = await prisma.auction.findFirst({
      where: { id: formData.get("auctionId")?.toString() || "", shop: session.shop },
    });
    if (!target) return { error: "Auction could not be found." };
    const now = new Date();

    if (intent === "cancel") {
      // eBay rule: a listing can only be ended early while nobody has bid.
      if (target.bidCount > 0) {
        return { error: "This auction already has bids, so it can't be cancelled. Every bidder is treated fairly." };
      }
      if (now >= target.endsAt) return { error: "This auction has already ended." };
      await prisma.auction.update({ where: { id: target.id }, data: { endsAt: now } });
      return { success: "Auction cancelled. It will be removed from Live Auctions within a few seconds." };
    }

    // Relist: only ended auctions that didn't sell.
    if (now < target.endsAt) return { error: "Only ended auctions can be relisted." };
    if (target.winnerId) return { error: "This auction sold, so it can't be relisted." };
    const quota = await canCreateAuction(session.shop);
    if (!quota.allowed) {
      return { error: `You've used all ${quota.limit} auctions on the ${quota.plan.name} plan this month. Upgrade on the "Plans & upgrades" page for more.` };
    }
    const lengthMs = new Date(target.endsAt).getTime() - new Date(target.startsAt).getTime();
    const collection = await ensureLiveAuctionsCollection(admin);
    if (collection?.id) {
      await admin.graphql(
        `#graphql
          mutation RelistJoin($id: ID!, $productIds: [ID!]!) {
            collectionAddProducts(id: $id, productIds: $productIds) { userErrors { message } }
          }`,
        { variables: { id: collection.id, productIds: [target.productId] } },
      );
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
        endsAt: new Date(now.getTime() + lengthMs),
        status: "LIVE",
      },
    });
    return { success: "Relisted! The auction is live again with the same price and length." };
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
    Number(formData.get("startingBid"));

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

  const durationDays =
    Number(formData.get("durationDays"));

  const imageFile = formData.get("image");

  if (
    !title ||
    !Number.isFinite(startingBid) ||
    startingBid <= 0 ||
    !startsAtDate ||
    !startsAtHour ||
    !startsAtMinute ||
    !startsAtAmPm ||
    !DURATION_OPTIONS.some(
      (option) =>
        Number(option.value) === durationDays,
    )
  ) {
    return {
      error: "Please complete all required auction fields.",
    };
  }

  const startsAt = easternLocalToUtc(
    startsAtDate,
    startsAtHour,
    startsAtMinute,
    startsAtAmPm,
    timezone,
  );

  const endsAt = new Date(
    startsAt.getTime() +
      durationDays * 24 * 60 * 60 * 1000,
  );

  const reservePrice =
    reservePriceValue !== null &&
    reservePriceValue !== ""
      ? Number(reservePriceValue)
      : null;

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
            product: {
              id: existingAuction.productId,
              title,
              descriptionHtml: cleanDescription,
            },
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

    const hasNewImage =
      imageFile &&
      typeof imageFile === "object" &&
      imageFile.size > 0;

    if (hasNewImage) {
      if (!imageFile.type?.startsWith("image/")) {
        return {
          error: "The replacement file must be an image.",
        };
      }

      const stagedResource =
        await uploadImage(admin, imageFile);

      /*
       * Add the replacement image to the EXISTING
       * Shopify product.
       */
      const mediaResponse = await admin.graphql(
        `#graphql
          mutation AddAuctionMedia(
            $productId: ID!
            $media: [CreateMediaInput!]!
          ) {
            productCreateMedia(
              productId: $productId
              media: $media
            ) {
              media {
                id
              }
              mediaUserErrors {
                message
              }
            }
          }
        `,
        {
          variables: {
            productId: existingAuction.productId,
            media: [
              {
                originalSource: stagedResource,
                alt: title,
                mediaContentType: "IMAGE",
              },
            ],
          },
        },
      );

      const mediaJson =
        await mediaResponse.json();

      const mediaErrors =
        mediaJson?.data?.productCreateMedia?.mediaUserErrors || [];

      if (mediaErrors.length) {
        return {
          error: mediaErrors
            .map((error) => error.message)
            .join(", "),
        };
      }

      const productImage =
        await getProductImage(
          admin,
          existingAuction.productId,
        );

      if (productImage.url) {
        imageUrl = productImage.url;
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
          title,
          description: description || null,
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
  if (
    !imageFile ||
    typeof imageFile !== "object" ||
    imageFile.size === 0
  ) {
    return {
      error: "Please upload an auction image.",
    };
  }

  if (!imageFile.type?.startsWith("image/")) {
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

  const stagedResource =
    await uploadImage(admin, imageFile);

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
            status: "ACTIVE",
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
          media: [
            {
              originalSource: stagedResource,
              alt: title,
              mediaContentType: "IMAGE",
            },
          ],
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
  onCancel,
  timezone,
}) {
  const isEdit = Boolean(auction);

  const initialParts = auction
    ? getEasternParts(auction.startsAt, timezone)
    : null;

  const [startDate, setStartDate] =
    useState(
      initialParts?.date || easternToday(timezone),
    );

  const [startHour, setStartHour] =
    useState(
      initialParts?.hour || "7",
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
      if (!auction) return "7";

      const days = Math.round(
        (
          new Date(auction.endsAt).getTime() -
          new Date(auction.startsAt).getTime()
        ) /
          (24 * 60 * 60 * 1000),
      );

      return DURATION_OPTIONS.some(
        (option) =>
          Number(option.value) === days,
      )
        ? String(days)
        : "7";
    });

  const [imagePreview, setImagePreview] =
    useState(
      auction?.imageUrl || null,
    );

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
          Number(duration) *
            24 *
            60 *
            60 *
            1000,
      );

      return formatEastern(end, timezone);
    } catch {
      return "Choose a valid start time";
    }
  };

  const handleImageChange = (event) => {
    const file =
      event.currentTarget.files?.[0];

    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setImagePreview(
        auction?.imageUrl || null,
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

        <s-text-field
          label="Auction Title"
          name="title"
          placeholder="Example: One-of-a-kind collectible"
          value={auction?.title || undefined}
          required
        />

        <s-text-area
          label="Description"
          name="description"
          placeholder="Describe the item being auctioned..."
          value={auction?.description || undefined}
        />

        <s-section
          heading={
            isEdit
              ? "Replace Auction Image"
              : "Auction Image"
          }
        >
          <s-stack gap="small">

            <s-drop-zone
              name="image"
              label={
                isEdit
                  ? "Choose a new image (optional)"
                  : "Upload auction image"
              }
              accessibilityLabel="Auction image"
              accept="image/*"
              required={!isEdit}
              onChange={handleImageChange}
            />

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
            auction
              ? String(auction.startingBid)
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
            auction?.reservePrice != null
              ? String(auction.reservePrice)
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
                  {[
                    "00",
                    "05",
                    "10",
                    "15",
                    "20",
                    "25",
                    "30",
                    "35",
                    "40",
                    "45",
                    "50",
                    "55",
                  ].map((minute) => (
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
  const { auctions, storefrontActivationUrl, timezone, showMenuBanner } = useLoaderData();
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

  const [editingId, setEditingId] =
    useState(null);

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
          <AuctionForm timezone={timezone} />
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
                        {state}
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
                    <div style={{ marginTop: "auto", paddingTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <s-button type="button" onClick={() => setEditingId(auction.id)}>
                        Edit
                      </s-button>
                      {state !== "ENDED" && auction.bidCount === 0 && (
                        <Form method="post" onSubmit={(e) => { if (!window.confirm("Cancel this auction? It has no bids, so it will simply end now.")) e.preventDefault(); }}>
                          <input type="hidden" name="intent" value="cancel" />
                          <input type="hidden" name="auctionId" value={auction.id} />
                          <s-button type="submit" tone="critical">Cancel</s-button>
                        </Form>
                      )}
                      {state === "ENDED" && !auction.winnerId && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="relist" />
                          <input type="hidden" name="auctionId" value={auction.id} />
                          <s-button type="submit" variant="primary">Relist</s-button>
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
