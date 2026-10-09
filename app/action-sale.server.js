import prisma from "./db.server.js";
import { claimDecision, openDecision, invoiceLines, remaining, MAX_DROPS } from "./action-sale.js";

// Live Drops: everything that touches the database or Shopify.

// FIRST TAP WINS. The item's row is locked while the claim is decided, so two people tapping at the same instant are
// handled one after the other and the quantity can never be oversold.
export async function claimDrop({ shop, dropId, customerId, want = 1, db = prisma }) {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`SELECT "id" FROM "ActionDrop" WHERE "id" = ${dropId} AND "shop" = ${shop} FOR UPDATE`;
    if (!locked.length) return { ok: false, code: "NOT_FOUND", message: "That item wasn't found." };
    const drop = await tx.actionDrop.findUnique({ where: { id: dropId }, include: { sale: { select: { status: true } } } });
    const held = await tx.actionClaim.aggregate({ where: { dropId, customerId }, _sum: { quantity: true } });
    const decision = claimDecision({ saleStatus: drop.sale.status, drop, already: held._sum.quantity || 0, want });
    if (!decision.ok) return decision;
    await tx.actionClaim.create({ data: { dropId, saleId: drop.saleId, shop, customerId, quantity: decision.quantity } });
    const claimed = drop.claimed + decision.quantity;
    await tx.actionDrop.update({ where: { id: dropId }, data: { claimed, ...(claimed >= drop.quantity ? { status: "CLOSED", closedAt: new Date() } : {}) } });
    return { ok: true, quantity: decision.quantity, remaining: drop.quantity - claimed, soldOut: claimed >= drop.quantity, saleId: drop.saleId, title: drop.title, price: drop.price };
  });
}

// ---------- the host's controls ----------
export async function openDrop({ shop, saleId, dropId, db = prisma }) {
  return db.$transaction(async (tx) => {
    const sale = await tx.actionSale.findFirst({ where: { id: saleId, shop }, include: { drops: true } });
    if (!sale) return { ok: false, message: "That show wasn't found." };
    const drop = sale.drops.find((d) => d.id === dropId);
    const decision = openDecision({ saleStatus: sale.status, drop });
    if (!decision.ok) return decision;
    await tx.actionDrop.updateMany({ where: { saleId, status: "OPEN" }, data: { status: "CLOSED", closedAt: new Date() } }); // one item at a time
    await tx.actionDrop.update({ where: { id: dropId }, data: { status: "OPEN", openedAt: new Date(), closedAt: null } });
    return { ok: true };
  });
}

export async function closeOpenDrop({ shop, saleId, db = prisma }) {
  const sale = await db.actionSale.findFirst({ where: { id: saleId, shop }, select: { id: true } });
  if (!sale) return { ok: false, message: "That show wasn't found." };
  const result = await db.actionDrop.updateMany({ where: { saleId, status: "OPEN" }, data: { status: "CLOSED", closedAt: new Date() } });
  return result.count ? { ok: true } : { ok: false, message: "No item is open." };
}

export async function addDropToSale({ shop, saleId, drop, db = prisma }) {
  const sale = await db.actionSale.findFirst({ where: { id: saleId, shop }, include: { drops: { select: { position: true } } } });
  if (!sale) return { ok: false, message: "That show wasn't found." };
  if (sale.status === "ENDED") return { ok: false, message: "This show has ended." };
  if (sale.drops.length >= MAX_DROPS) return { ok: false, message: `A show can have at most ${MAX_DROPS} items.` };
  const position = sale.drops.reduce((max, d) => Math.max(max, d.position), 0) + 1;
  await db.actionDrop.create({ data: { saleId, shop, position, ...drop } });
  return { ok: true };
}

// ---------- the shopper's cart: one draft order that grows with each claim ----------
const DRAFT_STATUS_QUERY = `#graphql
  query ActionDraft($id: ID!) { draftOrder(id: $id) { id status invoiceUrl } shop { currencyCode } }`;
const SHOP_QUERY = `#graphql
  query ActionShop { shop { currencyCode name } }`;

function lineInput(lines, currencyCode) {
  return lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, priceOverride: { amount: l.price.toFixed(2), currencyCode } }));
}
function userErrors(result, key) {
  const errors = result?.data?.[key]?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join(", "));
}

// Builds or updates the shopper's draft order from their claims (idempotent) and returns the payment link.
export async function checkoutFor({ shop, saleId, customerId, admin, db = prisma }) {
  const sale = await db.actionSale.findFirst({ where: { id: saleId, shop }, include: { drops: { orderBy: { position: "asc" } } } });
  if (!sale) return { ok: false, message: "That show wasn't found." };
  const claims = await db.actionClaim.findMany({ where: { saleId, shop, customerId }, orderBy: { createdAt: "asc" } });
  if (!claims.length) return { ok: false, message: "You haven't claimed anything yet." };
  const buyer = await db.actionBuyer.findUnique({ where: { saleId_customerId: { saleId, customerId } } });
  const gql = async (query, variables) => (await admin.graphql(query, { variables })).json();

  let draftId = buyer?.draftOrderId || null;
  let invoiceUrl = buyer?.invoiceUrl || null;
  let currencyCode = "USD";
  if (draftId) {
    const found = await gql(DRAFT_STATUS_QUERY, { id: draftId });
    currencyCode = found?.data?.shop?.currencyCode || currencyCode;
    const status = found?.data?.draftOrder?.status;
    if (!found?.data?.draftOrder || status === "COMPLETED") draftId = null; // paid (or gone): later claims start a new one
    else invoiceUrl = found.data.draftOrder.invoiceUrl || invoiceUrl;
  } else {
    currencyCode = (await gql(SHOP_QUERY, {}))?.data?.shop?.currencyCode || currencyCode;
  }

  const included = claims.filter((c) => !c.draftOrderId || (draftId && c.draftOrderId === draftId));
  if (!included.length) return { ok: false, paid: true, message: "Everything you claimed is already paid for." };
  const { lines, total } = invoiceLines({ claims: included, drops: sale.drops });
  if (!lines.length) return { ok: false, message: "Nothing to check out." };

  if (draftId) {
    const updated = await gql(`#graphql
      mutation ActionDraftUpdate($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) { draftOrder { id invoiceUrl } userErrors { field message } } }`,
    { id: draftId, input: { lineItems: lineInput(lines, currencyCode) } });
    userErrors(updated, "draftOrderUpdate");
    invoiceUrl = updated?.data?.draftOrderUpdate?.draftOrder?.invoiceUrl || invoiceUrl;
  } else {
    const created = await gql(`#graphql
      mutation ActionDraftCreate($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { field message } } }`,
    {
      input: {
        purchasingEntity: { customerId: `gid://shopify/Customer/${customerId}` },
        note: `Hellfire Live Drops: ${sale.title}`,
        tags: ["Hellfire Live Drops"],
        lineItems: lineInput(lines, currencyCode),
        customAttributes: [{ key: "Live Drops", value: sale.title }],
      },
    });
    userErrors(created, "draftOrderCreate");
    draftId = created?.data?.draftOrderCreate?.draftOrder?.id;
    invoiceUrl = created?.data?.draftOrderCreate?.draftOrder?.invoiceUrl || null;
    if (!draftId) throw new Error("Shopify did not create the order.");
  }

  await db.actionClaim.updateMany({ where: { id: { in: included.map((c) => c.id) } }, data: { draftOrderId: draftId } });
  await db.actionBuyer.upsert({
    where: { saleId_customerId: { saleId, customerId } },
    create: { saleId, customerId, shop, draftOrderId: draftId, invoiceUrl },
    update: { draftOrderId: draftId, invoiceUrl },
  });
  return { ok: true, url: invoiceUrl, total, draftOrderId: draftId };
}

// Builds the shopper's combined order and emails them the invoice (through Shopify, from the store's own email). Resets the
// payment reminders, because a new invoice starts the clock again. An order that is already paid is simply marked paid.
export async function invoiceBuyer({ shop, saleId, customerId, admin, db = prisma, saleTitle, shopName }) {
  const title = saleTitle || (await db.actionSale.findFirst({ where: { id: saleId, shop }, select: { title: true } }))?.title || "the live sale";
  const name = shopName || (await (await admin.graphql(SHOP_QUERY)).json())?.data?.shop?.name || "our store";
  const result = await checkoutFor({ shop, saleId, customerId, admin, db });
  if (!result.ok) {
    if (result.paid) {
      await db.actionBuyer.updateMany({ where: { saleId, customerId }, data: { invoiceSentAt: new Date(), paidAt: new Date() } });
      return { ok: true, skipped: "paid" };
    }
    return result;
  }
  const mail = await (await admin.graphql(`#graphql
    mutation ActionInvoice($id: ID!, $email: EmailInput) { draftOrderInvoiceSend(id: $id, email: $email) { draftOrder { id } userErrors { field message } } }`, {
    variables: { id: result.draftOrderId, email: { subject: `Your items from ${title} at ${name}`, customMessage: "Thanks for joining the live sale! Here are the items you claimed. Please complete your purchase with the secure link." } },
  })).json();
  userErrors(mail, "draftOrderInvoiceSend");
  await db.actionBuyer.update({
    where: { saleId_customerId: { saleId, customerId } },
    data: { invoiceSentAt: new Date(), reminder1At: null, reminder2At: null, ownerAlertedAt: null, paidAt: null, checkedAt: null },
  });
  return { ok: true, draftOrderId: result.draftOrderId, total: result.total };
}

// End the show: close the open item, then give every shopper who claimed something their combined invoice by email.
export async function endShowAndInvoice({ shop, saleId, admin, db = prisma, limit = 60 }) {
  const sale = await db.actionSale.findFirst({ where: { id: saleId, shop } });
  if (!sale) return { ok: false, message: "That show wasn't found." };
  if (sale.status !== "ENDED") {
    await db.actionDrop.updateMany({ where: { saleId, status: "OPEN" }, data: { status: "CLOSED", closedAt: new Date() } });
    await db.actionSale.update({ where: { id: saleId }, data: { status: "ENDED" } });
  }
  const people = (await db.actionClaim.findMany({ where: { saleId, shop }, select: { customerId: true }, distinct: ["customerId"] })).map((c) => c.customerId);
  let sent = 0;
  let failed = 0;
  let pending = 0;
  const shopInfo = (await (await admin.graphql(SHOP_QUERY)).json())?.data?.shop;
  for (const customerId of people) {
    const buyer = await db.actionBuyer.findUnique({ where: { saleId_customerId: { saleId, customerId } } });
    if (buyer?.invoiceSentAt) continue;
    if (sent + failed >= limit) { pending += 1; continue; }
    try {
      const done = await invoiceBuyer({ shop, saleId, customerId, admin, db, saleTitle: sale.title, shopName: shopInfo?.name });
      if (!done.ok || done.skipped) continue;
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error("[HELLFIRE LIVE DROPS] invoice failed:", saleId, customerId, error?.message || error);
    }
  }
  return { ok: true, people: people.length, sent, failed, pending };
}

export { remaining };
