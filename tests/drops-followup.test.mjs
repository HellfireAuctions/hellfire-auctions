import assert from "node:assert/strict";
import { needsInvoice, followUpAction, checkDue, reminderText, formatDue, AUTO_INVOICE_MINUTES, RETRY_MINUTES, CHECK_MINUTES } from "../app/drops-followup.js";
import { autoInvoicePass, followUpPass, noteDropActivity } from "../app/drops-followup.server.js";

const T0 = Date.parse("2026-10-09T12:00:00Z");
const min = (n) => n * 60_000;
const hr = (n) => n * 3_600_000;
const at = (ms) => new Date(ms);

// ---------- when is a shopper's invoice sent by itself? ----------
assert.equal(AUTO_INVOICE_MINUTES, 15);
assert.equal(needsInvoice({ lastClaimAt: at(T0 - min(15)), invoiceSentAt: null }, T0), true, "15 minutes after the last claim");
assert.equal(needsInvoice({ lastClaimAt: at(T0 - min(14)), invoiceSentAt: null }, T0), false, "not before");
assert.equal(needsInvoice({ lastClaimAt: at(T0 - min(60)), invoiceSentAt: at(T0 - min(30)) }, T0), false, "already invoiced since the last claim");
assert.equal(needsInvoice({ lastClaimAt: at(T0 - min(20)), invoiceSentAt: at(T0 - min(50)) }, T0), true, "claimed again after the last invoice: a new invoice");
assert.equal(needsInvoice({ lastClaimAt: at(T0 - min(60)), invoiceSentAt: null, invoiceAttemptAt: at(T0 - min(RETRY_MINUTES - 1)) }, T0), false, "a failed attempt waits before retrying");
assert.equal(needsInvoice({ lastClaimAt: at(T0 - min(60)), invoiceSentAt: null, invoiceAttemptAt: at(T0 - min(RETRY_MINUTES)) }, T0), true, "then tries again");
assert.equal(needsInvoice({ lastClaimAt: null }, T0), false, "no claims, no invoice");
assert.equal(needsInvoice({}, T0), false);

// ---------- the unpaid timeline (the same as auctions) ----------
const buyer = (hoursAgo, over = {}) => ({ invoiceSentAt: at(T0 - hr(hoursAgo)), ...over });
assert.equal(followUpAction(buyer(5), T0), null, "too early");
assert.equal(followUpAction(buyer(23.9), T0), null);
assert.equal(followUpAction(buyer(24), T0), "reminder1", "24 hours: the first reminder");
assert.equal(followUpAction(buyer(30, { reminder1At: at(T0) }), T0), null, "once only");
assert.equal(followUpAction(buyer(71.9), T0), "reminder1", "still the first reminder if it was missed");
assert.equal(followUpAction(buyer(72), T0), "reminder2", "72 hours: the second reminder");
assert.equal(followUpAction(buyer(80, { reminder2At: at(T0) }), T0), null);
assert.equal(followUpAction(buyer(96), T0), "final", "96 hours: the store owner and the strike");
assert.equal(followUpAction(buyer(120, { ownerAlertedAt: at(T0) }), T0), null, "once only");
assert.equal(followUpAction(buyer(100, { reminder1At: at(T0), reminder2At: at(T0) }), T0), "final", "earlier reminders do not stop the final step");
assert.equal(followUpAction(buyer(120, { paidAt: at(T0) }), T0), null, "paid: nothing");
assert.equal(followUpAction(buyer(24 * 7 + 1), T0), null, "after a week we stop");
assert.equal(followUpAction({ invoiceSentAt: null }, T0), null, "never invoiced");
assert.equal(followUpAction(null, T0), null);
assert.equal(checkDue({ checkedAt: null }, T0), true);
assert.equal(checkDue({ checkedAt: at(T0 - min(CHECK_MINUTES - 1)) }, T0), false, "checked recently");
assert.equal(checkDue({ checkedAt: at(T0 - min(CHECK_MINUTES)) }, T0), true);

// ---------- the reminder wording ----------
const r1 = reminderText("reminder1", { saleTitle: "Friday frags", total: "105.00", currency: "USD", dueAt: at(T0), timezone: "America/New_York" });
assert.match(r1.subject, /^Reminder: complete your purchase from Friday frags$/);
assert.match(r1.message, /friendly reminder/i);
assert.ok(r1.message.includes("105.00 USD") && r1.message.includes("Friday frags"));
assert.ok(r1.message.includes("8:00 AM"), "the deadline is in the store's own time zone (noon UTC is 8 AM in New York)");
const r2 = reminderText("reminder2", { saleTitle: "x", total: 5, dueAt: at(T0) });
assert.match(r2.subject, /^Last reminder/);
assert.match(r2.message, /last reminder/i);
assert.ok(reminderText("reminder1", {}).message.length > 20, "even with no details it reads fine");
assert.ok(formatDue(at(T0), undefined).endsWith("UTC"), "no time zone: it says UTC");
assert.ok(formatDue(at(T0), "Not/AZone").length > 5, "a bad time zone never throws");

// ---------- a pretend database and Shopify ----------
function world() {
  const state = { claims: [], buyers: [], sales: [{ id: "s1", title: "Friday frags" }], invoiced: [], reminders: [], strikes: [], alerts: [] };
  const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ("gte" in v) return row[k] != null && new Date(row[k]).getTime() >= new Date(v.gte).getTime();
      if ("in" in v) return v.in.includes(row[k]);
    }
    return v === null ? row[k] == null : row[k] === v;
  });
  const db = {
    actionClaim: {
      groupBy: async ({ where }) => {
        const groups = new Map();
        for (const c of state.claims.filter((c) => matches(c, where))) {
          const key = `${c.saleId}:${c.customerId}`;
          const g = groups.get(key) || { saleId: c.saleId, customerId: c.customerId, shop: c.shop, _max: { createdAt: null } };
          if (!g._max.createdAt || c.createdAt > g._max.createdAt) g._max.createdAt = c.createdAt;
          groups.set(key, g);
        }
        return [...groups.values()];
      },
    },
    actionBuyer: {
      findMany: async ({ where, take }) => state.buyers.filter((b) => matches(b, where)).slice(0, take || 999),
      upsert: async ({ where, create, update }) => {
        const k = where.saleId_customerId;
        const row = state.buyers.find((b) => b.saleId === k.saleId && b.customerId === k.customerId);
        if (row) Object.assign(row, update); else state.buyers.push({ ...create });
      },
      updateMany: async ({ where, data }) => { state.buyers.filter((b) => matches(b, where)).forEach((b) => Object.assign(b, data)); },
    },
    actionSale: { findFirst: async ({ where }) => state.sales.find((s) => s.id === where.id) || null },
  };
  return { state, db };
}
const claim = (saleId, customerId, createdAt) => ({ saleId, customerId, shop: "a.myshopify.com", createdAt: at(createdAt) });

// ---------- automatic invoices ----------
let { state, db } = world();
state.claims.push(claim("s1", "c1", T0 - min(20)), claim("s1", "c1", T0 - min(40)), claim("s1", "c2", T0 - min(5)), claim("s1", "c3", T0 - min(90)));
state.buyers.push({ saleId: "s1", customerId: "c3", shop: "a.myshopify.com", draftOrderId: "d3", invoiceSentAt: at(T0 - min(60)) }); // c3 already invoiced after their last claim
let sentTo = [];
const invoice = async ({ customerId }) => { sentTo.push(customerId); return { ok: true }; };
let out = await autoInvoicePass({ db, now: T0, getAdmin: async () => ({}), deps: { invoice } });
assert.deepEqual(sentTo, ["c1"], "only the shopper who has been quiet for 15 minutes and is not yet invoiced");
assert.deepEqual(out, { invoiced: 1, failed: 0 });
assert.ok(state.buyers.find((b) => b.customerId === "c1").invoiceAttemptAt, "the attempt is noted");
sentTo = [];
out = await autoInvoicePass({ db, now: T0 + min(1), getAdmin: async () => ({}), deps: { invoice: async () => { throw new Error("Shopify is down"); } } });
assert.deepEqual(out, { invoiced: 0, failed: 0 }, "a shopper just attempted is left alone for a few minutes");
out = await autoInvoicePass({ db, now: T0 + min(12), getAdmin: async () => ({}), deps: { invoice: async () => { throw new Error("Shopify is down"); } } });
assert.ok(out.failed >= 1 && out.invoiced === 0, "a failure is counted and never crashes the pass");
out = await autoInvoicePass({ db, now: T0 + min(30), getAdmin: async () => ({}), deps: { invoice: async () => ({ ok: false, message: "nothing" }) } });
assert.equal(out.invoiced, 0);
({ state, db } = world());
assert.deepEqual(await autoInvoicePass({ db, now: T0, getAdmin: async () => ({}), deps: { invoice } }), { invoiced: 0, failed: 0 }, "no claims: nothing to do");
({ state, db } = world());
state.claims.push(claim("s1", "old", T0 - 8 * 86_400_000));
sentTo = [];
await autoInvoicePass({ db, now: T0, getAdmin: async () => ({}), deps: { invoice } });
assert.deepEqual(sentTo, [], "claims older than a week are left alone");
({ state, db } = world());
for (let i = 0; i < 40; i += 1) state.claims.push(claim("s1", "c" + i, T0 - min(60)));
sentTo = [];
await autoInvoicePass({ db, now: T0, getAdmin: async () => ({}), deps: { invoice } });
assert.equal(sentTo.length, 25, "a busy pass handles 25 shoppers; the rest follow a minute later");

// ---------- payment checks, reminders and strikes ----------
const buyerRow = (hoursAgo, over = {}) => ({ saleId: "s1", customerId: "c1", shop: "a.myshopify.com", draftOrderId: "gid://shopify/DraftOrder/1", invoiceSentAt: at(T0 - hr(hoursAgo)), ...over });
const info = (status = "INVOICE_SENT") => ({ status, total: "105.00", currency: "USD", timezone: "America/New_York" });
const calls = () => ({ reminders: [], strikes: [], alerts: [] });
const mk = (c, statusValue = info()) => ({
  status: async () => statusValue,
  resend: async (admin, id, text) => c.reminders.push(text.subject),
  strike: async (a) => { c.strikes.push(a.customerId); return { strikes: 1, blocked: false }; },
  tell: async (a) => c.alerts.push(a.saleTitle),
});
const run = (db, c, now, statusValue) => followUpPass({ db, now, getAdmin: async () => ({}), deps: mk(c, statusValue) });

({ state, db } = world());
let c = calls();
state.buyers.push(buyerRow(5));
out = await run(db, c, T0);
assert.deepEqual([out.checked, out.reminders, out.strikes], [1, 0, 0], "5 hours: checked, nothing due");
assert.ok(state.buyers[0].checkedAt, "the check is noted");
out = await run(db, c, T0 + min(1));
assert.equal(out.checked, 0, "not checked again for ten minutes");

({ state, db } = world());
c = calls();
state.buyers.push(buyerRow(25));
out = await run(db, c, T0);
assert.deepEqual(c.reminders, ["Reminder: complete your purchase from Friday frags"], "24 hours: reminder one");
assert.ok(state.buyers[0].reminder1At);
out = await run(db, c, T0 + min(20));
assert.equal(c.reminders.length, 1, "never twice");

({ state, db } = world());
c = calls();
state.buyers.push(buyerRow(73, { reminder1At: at(T0 - hr(40)) }));
await run(db, c, T0);
assert.deepEqual(c.reminders, ["Last reminder: complete your purchase from Friday frags"], "72 hours: the last reminder");
assert.ok(state.buyers[0].reminder2At);

({ state, db } = world());
c = calls();
state.buyers.push(buyerRow(97, { reminder1At: at(T0 - hr(70)), reminder2At: at(T0 - hr(20)) }));
out = await run(db, c, T0);
assert.deepEqual(c.strikes, ["c1"], "96 hours: the unpaid strike");
assert.deepEqual(c.alerts, ["Friday frags"], "and the store owner is told");
assert.ok(state.buyers[0].ownerAlertedAt);
assert.equal(out.strikes, 1);
await run(db, c, T0 + min(30));
assert.equal(c.strikes.length, 1, "once only");

// paid: stops everything, even when a reminder was due
({ state, db } = world());
c = calls();
state.buyers.push(buyerRow(30));
out = await run(db, c, T0, info("COMPLETED"));
assert.deepEqual([out.paid, c.reminders.length], [1, 0], "a paid invoice gets no reminder");
assert.ok(state.buyers[0].paidAt, "and is marked paid");
out = await run(db, c, T0 + min(30), info("COMPLETED"));
assert.equal(out.checked, 0, "never checked again");
// the store deleted the order: also finished, and not counted as paid
({ state, db } = world());
c = calls();
state.buyers.push(buyerRow(100));
out = await run(db, c, T0, null);
assert.deepEqual([out.paid, c.strikes.length, c.alerts.length], [0, 0, 0], "a deleted order is never a strike");
assert.ok(state.buyers[0].paidAt);
// an error on one shopper does not stop the others
({ state, db } = world());
c = calls();
state.buyers.push(buyerRow(30, { customerId: "bad", draftOrderId: "bad" }), buyerRow(30, { customerId: "ok", draftOrderId: "ok" }));
await followUpPass({ db, now: T0, getAdmin: async () => ({}), deps: { ...mk(c), status: async (a, id) => { if (id === "bad") throw new Error("boom"); return info(); } } });
assert.equal(c.reminders.length, 1, "the next shopper is still handled");
// invoices older than a week are not followed up
({ state, db } = world());
c = calls();
state.buyers.push(buyerRow(24 * 8));
out = await run(db, c, T0);
assert.equal(out.checked, 0);

// ---------- the timer ----------
noteDropActivity(T0);
assert.ok(true, "activity can be noted");

console.log("Live Drops invoicing and unpaid follow-up: all checks passed");
