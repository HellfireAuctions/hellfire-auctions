// Live Drops: automatic invoices and unpaid follow-up. The same timeline as auctions (reminders at 24 and 72 hours, the store
// owner and a strike at 96 hours), plus an invoice that goes out by itself 15 minutes after a shopper's last claim.
// Pure rules only, so they can be tested without a database.

export const AUTO_INVOICE_MINUTES = 15;
export const RETRY_MINUTES = 10; // after a failed attempt, wait this long before trying again
export const CHECK_MINUTES = 10; // how often an unpaid invoice is checked for payment
export const REMINDER_1_HOURS = 24;
export const REMINDER_2_HOURS = 72;
export const FINAL_HOURS = 96;
export const FOLLOW_UP_DAYS = 7; // after a week, we stop following up

const ms = (d) => (d ? new Date(d).getTime() : 0);

// Should this shopper's claims be invoiced now? Quiet for 15 minutes, and not yet invoiced since their last claim.
export function needsInvoice({ lastClaimAt, invoiceSentAt, invoiceAttemptAt }, now = Date.now()) {
  const last = ms(lastClaimAt);
  if (!last || now - last < AUTO_INVOICE_MINUTES * 60_000) return false;
  if (invoiceSentAt && ms(invoiceSentAt) >= last) return false;
  if (invoiceAttemptAt && now - ms(invoiceAttemptAt) < RETRY_MINUTES * 60_000) return false;
  return true;
}

// What follow-up is due for an unpaid invoice? Each step happens once.
export function followUpAction(buyer, now = Date.now()) {
  if (!buyer || !buyer.invoiceSentAt || buyer.paidAt) return null;
  const hours = (now - ms(buyer.invoiceSentAt)) / 3_600_000;
  if (hours > FOLLOW_UP_DAYS * 24) return null;
  if (hours >= FINAL_HOURS) return buyer.ownerAlertedAt ? null : "final";
  if (hours >= REMINDER_2_HOURS) return buyer.reminder2At ? null : "reminder2";
  if (hours >= REMINDER_1_HOURS) return buyer.reminder1At ? null : "reminder1";
  return null;
}

export const checkDue = (buyer, now = Date.now()) => !buyer.checkedAt || now - ms(buyer.checkedAt) >= CHECK_MINUTES * 60_000;

export function formatDue(date, timezone) {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone || "UTC" }).format(date).replace(/[\u202f\u00a0]/g, " ") + (timezone ? "" : " UTC");
  } catch {
    return new Date(date).toUTCString();
  }
}

// The wording of a payment reminder (sent through Shopify, from the store's own invoice email).
export function reminderText(kind, { saleTitle = "the live sale", total, currency, dueAt, timezone } = {}) {
  const amount = total != null && Number.isFinite(Number(total)) ? `${Number(total).toFixed(2)}${currency ? " " + currency : ""}` : "";
  const due = dueAt ? formatDue(dueAt, timezone) : "";
  const subject = kind === "reminder2" ? `Last reminder: complete your purchase from ${saleTitle}` : `Reminder: complete your purchase from ${saleTitle}`;
  const lead = kind === "reminder2" ? "This is a last reminder." : "A friendly reminder.";
  const message = `${lead} The items you claimed in "${saleTitle}"${amount ? ` (${amount} in total)` : ""} are waiting for you. ${due ? `Please complete your purchase by ${due} ` : "Please complete your purchase soon "}so the seller can ship them to you.`;
  return { subject, message };
}
