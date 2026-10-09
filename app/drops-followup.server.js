import prisma from "./db.server.js";
import { invoiceBuyer } from "./action-sale.server.js";
import { applyStrikeLimit } from "./settings.server.js";
import { needsInvoice, followUpAction, checkDue, reminderText, FINAL_HOURS, FOLLOW_UP_DAYS } from "./drops-followup.js";

// Live Drops: the background work. Every minute while a show is active (every ten minutes otherwise):
//   1. a shopper whose last claim is 15 minutes old is emailed one combined invoice;
//   2. every unpaid invoice is checked for payment, reminded at 24 and 72 hours, and at 96 hours the store owner is
//      emailed and the shopper gets an unpaid strike (strikes count together with auction strikes, and block at the
//      store's limit).

const DAY = 86_400_000;

async function defaultAdmin(shop) {
  const { unauthenticated } = await import("./shopify.server.js");
  return (await unauthenticated.admin(shop)).admin;
}

// What Shopify says about an unpaid invoice (or null if it is gone).
export async function draftInfo(admin, draftId) {
  const json = await (
    await admin.graphql(
      `#graphql
        query DropDraftInfo($id: ID!) {
          draftOrder(id: $id) { status totalPriceSet { shopMoney { amount currencyCode } } }
          shop { name ianaTimezone }
        }`,
      { variables: { id: draftId } },
    )
  ).json();
  const draft = json?.data?.draftOrder;
  if (!draft) return null;
  return { status: draft.status, total: draft.totalPriceSet?.shopMoney?.amount, currency: draft.totalPriceSet?.shopMoney?.currencyCode, shopName: json?.data?.shop?.name, timezone: json?.data?.shop?.ianaTimezone };
}

// A reminder is Shopify's own invoice email sent again with a short note, so it looks like the store's other email.
export async function resendInvoice(admin, draftId, { subject, message }) {
  const json = await (
    await admin.graphql(
      `#graphql
        mutation DropReminder($id: ID!, $email: EmailInput) { draftOrderInvoiceSend(id: $id, email: $email) { userErrors { message } } }`,
      { variables: { id: draftId, email: { subject, customMessage: message } } },
    )
  ).json();
  const errors = json?.data?.draftOrderInvoiceSend?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join(", "));
}

// An unpaid Live Drops order counts as one strike, the same as an unpaid auction win.
export async function recordDropStrike({ shop, saleId, customerId, db = prisma, now = Date.now() }) {
  await db.actionBuyer.updateMany({ where: { saleId, customerId, struckAt: null }, data: { struckAt: new Date(now) } });
  return applyStrikeLimit(shop, customerId);
}

// 1. Invoices that go out by themselves.
export async function autoInvoicePass({ db = prisma, now = Date.now(), getAdmin = defaultAdmin, deps = {} } = {}) {
  const { invoice = invoiceBuyer } = deps;
  const out = { invoiced: 0, failed: 0 };
  const groups = await db.actionClaim.groupBy({ by: ["saleId", "customerId", "shop"], where: { createdAt: { gte: new Date(now - FOLLOW_UP_DAYS * DAY) } }, _max: { createdAt: true } });
  if (!groups.length) return out;
  const buyers = await db.actionBuyer.findMany({ where: { saleId: { in: [...new Set(groups.map((g) => g.saleId))] } } });
  const known = new Map(buyers.map((b) => [`${b.saleId}:${b.customerId}`, b]));
  const due = groups
    .filter((g) => {
      const b = known.get(`${g.saleId}:${g.customerId}`);
      return needsInvoice({ lastClaimAt: g._max.createdAt, invoiceSentAt: b?.invoiceSentAt, invoiceAttemptAt: b?.invoiceAttemptAt }, now);
    })
    .slice(0, 25);
  for (const g of due) {
    try {
      // note the attempt first, so a failing shopper is retried every few minutes and not every minute
      await db.actionBuyer.upsert({
        where: { saleId_customerId: { saleId: g.saleId, customerId: g.customerId } },
        create: { saleId: g.saleId, customerId: g.customerId, shop: g.shop, invoiceAttemptAt: new Date(now) },
        update: { invoiceAttemptAt: new Date(now) },
      });
      const result = await invoice({ shop: g.shop, saleId: g.saleId, customerId: g.customerId, admin: await getAdmin(g.shop), db });
      if (result.ok) out.invoiced += 1;
      else out.failed += 1;
    } catch (error) {
      out.failed += 1;
      console.error("[HELLFIRE LIVE DROPS] automatic invoice failed:", g.saleId, g.customerId, error?.message || error);
    }
  }
  if (out.invoiced) console.log("[HELLFIRE LIVE DROPS]", JSON.stringify({ autoInvoiced: out.invoiced, failed: out.failed }));
  return out;
}

// 2. Payment checks, reminders, and the unpaid strike.
export async function followUpPass({ db = prisma, now = Date.now(), getAdmin = defaultAdmin, deps = {} } = {}) {
  const { status = draftInfo, resend = resendInvoice, strike = recordDropStrike, tell = (args) => import("./notifications.server.js").then((m) => m.notifyMerchantDropUnpaid(args)) } = deps;
  const out = { checked: 0, paid: 0, reminders: 0, strikes: 0 };
  const buyers = await db.actionBuyer.findMany({
    where: { invoiceSentAt: { gte: new Date(now - FOLLOW_UP_DAYS * DAY) }, draftOrderId: { not: null }, paidAt: null },
    orderBy: { invoiceSentAt: "asc" },
    take: 80,
  });
  const admins = new Map();
  for (const b of buyers) {
    if (!checkDue(b, now)) continue;
    const key = { saleId: b.saleId, customerId: b.customerId };
    try {
      if (!admins.has(b.shop)) admins.set(b.shop, await getAdmin(b.shop));
      const admin = admins.get(b.shop);
      const info = await status(admin, b.draftOrderId);
      out.checked += 1;
      if (!info || info.status === "COMPLETED") {
        // paid (or the store deleted the order): nothing more to follow up
        await db.actionBuyer.updateMany({ where: key, data: { paidAt: new Date(now), checkedAt: new Date(now) } });
        if (info) out.paid += 1;
        continue;
      }
      await db.actionBuyer.updateMany({ where: key, data: { checkedAt: new Date(now) } });
      const action = followUpAction(b, now);
      if (!action) continue;
      const sale = await db.actionSale.findFirst({ where: { id: b.saleId }, select: { title: true } });
      const saleTitle = sale?.title || "the live sale";
      if (action === "reminder1" || action === "reminder2") {
        const text = reminderText(action, { saleTitle, total: info.total, currency: info.currency, dueAt: new Date(new Date(b.invoiceSentAt).getTime() + FINAL_HOURS * 3_600_000), timezone: info.timezone });
        await resend(admin, b.draftOrderId, text);
        await db.actionBuyer.updateMany({ where: key, data: action === "reminder1" ? { reminder1At: new Date(now) } : { reminder2At: new Date(now) } });
        out.reminders += 1;
      } else if (action === "final") {
        const result = await strike({ shop: b.shop, saleId: b.saleId, customerId: b.customerId, db, now });
        await tell({ shop: b.shop, saleTitle, total: info.total, currency: info.currency, strikes: result.strikes, blocked: result.blocked });
        await db.actionBuyer.updateMany({ where: key, data: { ownerAlertedAt: new Date(now) } });
        out.strikes += 1;
      }
    } catch (error) {
      console.error("[HELLFIRE LIVE DROPS] payment follow-up failed:", b.saleId, b.customerId, error?.message || error);
    }
  }
  if (out.reminders || out.strikes || out.paid) console.log("[HELLFIRE LIVE DROPS]", JSON.stringify({ followUp: out }));
  return out;
}

// ---- the timer: every minute while claims are fresh, every ten minutes otherwise (so a quiet store never wakes the database) ----
let hotUntil = 0;
let lastRun = 0;
let running = false;
export const noteDropActivity = (now = Date.now()) => { hotUntil = now + 40 * 60_000; };

export async function dropsTick({ now = Date.now(), force = false } = {}) {
  if (running) return;
  if (!force && now > hotUntil && now - lastRun < 10 * 60_000) return;
  running = true;
  lastRun = now;
  try {
    await autoInvoicePass({ now });
    await followUpPass({ now });
  } catch (error) {
    console.error("[HELLFIRE LIVE DROPS] background pass failed:", error?.message || error);
  } finally {
    running = false;
  }
}

export function startDropsFollowUp() {
  if (globalThis.__HELLFIRE_DROPS_TIMER__) return;
  globalThis.__HELLFIRE_DROPS_TIMER__ = true;
  setTimeout(() => dropsTick({ force: true }), 3 * 60_000).unref?.();
  setInterval(() => dropsTick(), 60_000).unref?.();
}
