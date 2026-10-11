import crypto from "node:crypto";
import prisma from "./db.server.js";

// Live Drops and the store's stock. Each item has its own hidden product. That product tracks inventory, set to the quantity
// for sale. When a shopper pays their invoice, Shopify itself takes the units off, so the store's stock is always right.
// Unpaid claims take nothing off (the units are still yours), and the app already stops claims at the quantity.

const LOOKUP = `#graphql
  query DropStockLookup($id: ID!) {
    product(id: $id) { variants(first: 1) { nodes { id inventoryItem { id } } } }
    locations(first: 1) { nodes { id } }
  }`;
const TRACK = `#graphql
  mutation DropTrack($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
  }`;
const SET_STOCK = `#graphql
  mutation DropStock($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { message } }
  }`;

const errorsOf = (json, key) => (json?.data?.[key]?.userErrors || []).map((e) => e.message).join(", ");

// Turns stock tracking on for the item's product and sets its stock to the quantity. Never throws: a stock problem must not
// stop a show, so the answer says what went wrong.
export async function syncDropStock({ admin, productId, quantity, uuid = () => crypto.randomUUID() }) {
  try {
    const found = await (await admin.graphql(LOOKUP, { variables: { id: productId } })).json();
    const variant = found?.data?.product?.variants?.nodes?.[0];
    const locationId = found?.data?.locations?.nodes?.[0]?.id;
    if (!variant?.id || !variant?.inventoryItem?.id) return { ok: false, reason: "the product could not be found" };
    if (!locationId) return { ok: false, reason: "the store has no stock location" };

    // "CONTINUE" so a paying shopper is never blocked at checkout (the app limits claims to the quantity itself)
    const tracked = await (await admin.graphql(TRACK, { variables: { productId, variants: [{ id: variant.id, inventoryPolicy: "CONTINUE", inventoryItem: { tracked: true } }] } })).json();
    if (errorsOf(tracked, "productVariantsBulkUpdate")) return { ok: false, reason: errorsOf(tracked, "productVariantsBulkUpdate") };

    const amount = Math.max(0, Math.floor(Number(quantity)) || 0);
    const set = await (
      await admin.graphql(SET_STOCK, {
        variables: {
          input: { name: "available", reason: "correction", quantities: [{ inventoryItemId: variant.inventoryItem.id, locationId, quantity: amount, changeFromQuantity: null }] },
          idempotencyKey: uuid(),
        },
      })
    ).json();
    if (errorsOf(set, "inventorySetQuantities")) return { ok: false, reason: errorsOf(set, "inventorySetQuantities") };
    return { ok: true, locationId, quantity: amount };
  } catch (error) {
    return { ok: false, reason: error?.message || "unknown error" };
  }
}

// Items added before stock tracking existed (or whose setup failed) are set up when a show starts or an item opens.
export async function ensureStockForSale({ shop, saleId, admin, db = prisma, sync = syncDropStock }) {
  const out = { synced: 0, failed: 0 };
  try {
    const drops = await db.actionDrop.findMany({ where: { saleId, shop, stockSynced: false } });
    for (const drop of drops) {
      const result = await sync({ admin, productId: drop.productId, quantity: drop.quantity });
      if (result.ok) {
        await db.actionDrop.update({ where: { id: drop.id }, data: { stockSynced: true } });
        out.synced += 1;
      } else {
        out.failed += 1;
        console.error("[HELLFIRE LIVE DROPS] stock not set up for an item:", drop.id, result.reason);
      }
    }
  } catch (error) {
    console.error("[HELLFIRE LIVE DROPS] stock check failed:", error?.message || error);
  }
  return out;
}

// The same, for places that have no Shopify login at hand (the phone Studio).
export async function ensureStockForShop({ shop, saleId }) {
  try {
    const { unauthenticated } = await import("./shopify.server.js");
    const { admin } = await unauthenticated.admin(shop);
    return await ensureStockForSale({ shop, saleId, admin });
  } catch (error) {
    console.error("[HELLFIRE LIVE DROPS] stock check failed:", error?.message || error);
    return { synced: 0, failed: 0 };
  }
}
