// Bidder notifications: "you've been outbid" and "1 hour left".
// Switched OFF automatically until RESEND_API_KEY and NOTIFY_FROM are set on the server.
// Every send is recorded, so a customer never gets the same notice twice.
import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";
import { getShopPlan } from "./plans.server.js";

import { prefsUrl, prefsAllow } from "./prefs.server.js";
import { translateEmailParts, footerWords, normalizeLang } from "./email-i18n.server.js";

const RESEND_URL = "https://api.resend.com/emails";
const OUTBID_WINDOW_MS = 10 * 60_000; // at most one outbid email per bidder per auction per 10 minutes
const ENDING_SOON_MS = 60 * 60_000;

export function notificationsEnabled() {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM);
}

let emailCurrency = "USD";
function useCurrency(data) {
  emailCurrency = data?.shop?.currencyCode || "USD";
}
function money(value) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: emailCurrency }).format(Number(value || 0));
  } catch {
    return `${Number(value || 0).toFixed(2)}`;
  }
}

function friendlyTime(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(date));
  } catch {
    return new Date(date).toUTCString();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// The buyer's own language, from their Shopify customer account. Any problem means English.
const langCache = new Map();
async function customerLanguage(shop, customerId) {
  const key = `${shop}|${customerId}`;
  const hit = langCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.lang;
  let lang = "en";
  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(
      `#graphql
        query CustomerLocale($id: ID!) { customer(id: $id) { locale } }`,
      { variables: { id: String(customerId).startsWith("gid://") ? String(customerId) : `gid://shopify/Customer/${customerId}` } },
    );
    lang = normalizeLang((await response.json())?.data?.customer?.locale);
  } catch {
    // keep English
  }
  if (langCache.size > 2000) langCache.clear();
  langCache.set(key, { lang, at: Date.now() });
  return lang;
}

async function lookupRaw(shop, customerId, productId) {
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(
    `#graphql
      query NotifyLookup($customer: ID!, $product: ID!) {
        customer(id: $customer) { email }
        product(id: $product) { title handle onlineStoreUrl }
        shop { name email contactEmail ianaTimezone currencyCode primaryDomain { url } }
      }
    `,
    {
      variables: {
        customer: String(customerId).startsWith("gid://")
          ? String(customerId)
          : `gid://shopify/Customer/${customerId}`,
        product: productId,
      },
    },
  );
  const json = await response.json();
  return json?.data || {};
}

// Returns true only the first time this exact notice is recorded.
async function lookup(shop, customerId, productId) {
  const data = await lookupRaw(shop, customerId, productId);
  try {
    if (data && typeof data === "object" && customerId && String(customerId) !== "0") {
      data.lang = await customerLanguage(shop, customerId);
      data.prefsUrl = prefsUrl(shop, customerId, data.lang);
    }
  } catch {
    // no link: the email just won't carry one
  }
  return data;
}

async function releaseNotice({ auctionId, customerId, type, key }) {
  try {
    await prisma.auctionNotification.deleteMany({ where: { auctionId, customerId: String(customerId), type, key } });
  } catch {}
}

// Optional emails a customer can switch off (everything else, such as winner and payment emails, always sends).
const OPTIONAL_CATEGORY = { OUTBID: "outbid", ENDING_SOON: "reminders", WATCH_START: "reminders", LOST: "results", RESERVE_NOT_MET: "results" };

async function claimNotice({ auctionId, customerId, type, key }) {
  const category = OPTIONAL_CATEGORY[type];
  if (category && auctionId && customerId) {
    const owner = await prisma.auction.findUnique({ where: { id: auctionId }, select: { shop: true } });
    if (owner && !(await prefsAllow(owner.shop, customerId, category, type))) return false; // the customer turned this off
  }
  try {
    await prisma.auctionNotification.create({
      data: { auctionId, customerId: String(customerId), type, key },
    });
    return true;
  } catch (error) {
    if (error?.code === "P2002") return false; // already sent
    throw error;
  }
}

function auctionLink(data) {
  if (data?.product?.onlineStoreUrl) return data.product.onlineStoreUrl;
  const base = data?.shop?.primaryDomain?.url;
  return base && data?.product?.handle ? `${base.replace(/\/$/, "")}/products/${data.product.handle}` : null;
}

async function sendEmail(args) {
  try {
    const result = await sendEmailRaw(args);
    globalThis.__HF_EMAIL_FAILS__ = 0;
    return result;
  } catch (error) {
    globalThis.__HF_EMAIL_FAILS__ = (globalThis.__HF_EMAIL_FAILS__ || 0) + 1;
    throw error;
  }
}

async function sendEmailRaw({ to, subject, heading, lines, buttonLabel, buttonUrl, shopName, replyTo, imageUrl, prefsUrl: manageUrl, lang }) {
  // Buyer emails are written in English and translated here for buyers whose account language is Spanish.
  if (lang && lang !== "en") ({ subject, heading, lines, buttonLabel } = translateEmailParts(lang, { subject, heading, lines, buttonLabel }));
  const words = footerWords(lang);
  const htmlLines = lines.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join("");
  const button = buttonUrl
    ? `<p style="margin:20px 0"><a href="${escapeHtml(buttonUrl)}" style="background:#ff3b30;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${escapeHtml(buttonLabel)}</a></p>`
    : "";
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#151515">
    ${imageUrl && /^https:\/\//.test(imageUrl) ? `<p style="margin:0 0 16px"><img src="${escapeHtml(imageUrl)}" alt="" style="max-width:100%;max-height:320px;border-radius:10px;display:block"></p>` : ""}<h2 style="margin:0 0 16px">${escapeHtml(heading)}</h2>${htmlLines}${button}
    <p style="margin:24px 0 0;font-size:12px;color:#777">${escapeHtml(words.sent(shopName))}${manageUrl ? ` <a href="${escapeHtml(manageUrl)}" style="color:#777">${escapeHtml(words.manage)}</a>.` : ""}</p>
  </div>`;
  const text = [heading, "", ...lines, buttonUrl ? `\n${buttonLabel}: ${buttonUrl}` : "", manageUrl ? `\n${words.manage}: ${manageUrl}` : ""].join("\n");

  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM,
      to: [to],
      subject,
      html,
      text,
      reply_to: replyTo || process.env.NOTIFY_REPLY_TO || undefined,
      headers: manageUrl ? { "List-Unsubscribe": `<${manageUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
    }),
  });
  if (!response.ok) {
    throw new Error(`email provider HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

// Called after a bid commits, for the bidder who just lost the lead.
export async function notifyOutbid({ shop, auction, outbidCustomerId, currentBid }) {
  if (!notificationsEnabled() || !outbidCustomerId) return;
  try {
    if (!(await getShopPlan(shop)).emails) return;
    const key = String(Math.floor(Date.now() / OUTBID_WINDOW_MS));
    const fresh = await claimNotice({ auctionId: auction.id, customerId: outbidCustomerId, type: "OUTBID", key });
    if (!fresh) return;

    const data = await lookup(shop, outbidCustomerId, auction.productId);
    useCurrency(data);
    const email = data?.customer?.email;
    if (!email) return;

    const title = data?.product?.title || auction.title;
    await sendEmail({
      to: email,
      subject: `You've been outbid on ${title}`,
      heading: "You've been outbid!",
      lines: [
        "Hey there,",
        `We're letting you know you've been outbid on "${title}". The current bid is now ${money(currentBid)}.`,
        `The auction ends ${friendlyTime(auction.endsAt, data?.shop?.ianaTimezone)}, so jump back in and raise your bid before time runs out.`,
      ],
      buttonLabel: "Bid Again Now",
      buttonUrl: auctionLink(data),
      shopName: data?.shop?.name || "the store",
      replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
        prefsUrl: data?.prefsUrl,
    });
    console.log("[notify] outbid email sent", JSON.stringify({ auctionId: auction.id, customerId: outbidCustomerId }));
  } catch (error) {
    await releaseNotice({ auctionId: auction.id, customerId: outbidCustomerId, type: "OUTBID", key: String(Math.floor(Date.now() / OUTBID_WINDOW_MS)) });
    console.error("[notify] outbid email failed:", error?.message || error);
  }
}

// Called by the worker every tick: one reminder per bidder when an auction has 1 hour left.
export async function sendEndingSoonReminders() {
  if (!notificationsEnabled()) return;
  const now = new Date();
  const auctions = await prisma.auction.findMany({
    where: { startsAt: { lte: now }, endsAt: { gt: now, lte: new Date(now.getTime() + ENDING_SOON_MS) } },
    include: { bids: { orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }] } },
    take: 25,
  });

  for (const auction of auctions) {
    if (auction.endsAt.getTime() - auction.startsAt.getTime() <= ENDING_SOON_MS) continue; // short/test auctions: no reminder
    if (!(await getShopPlan(auction.shop)).emails) continue;
    const leaderId = auction.bids[0]?.bidderId;
    for (const bid of auction.bids) {
      try {
        const fresh = await claimNotice({ auctionId: auction.id, customerId: bid.bidderId, type: "ENDING_SOON", key: "1h" });
        if (!fresh) continue;

        const data = await lookup(auction.shop, bid.bidderId, auction.productId);
    useCurrency(data);
        const email = data?.customer?.email;
        if (!email) continue;

        const title = data?.product?.title || auction.title;
        const winning = bid.bidderId === leaderId;
        await sendEmail({
          to: email,
          subject: `1 hour left: ${title}`,
          heading: "Less than 1 hour left",
          lines: [
            "Hey there,",
            `The auction for "${title}" ends at ${friendlyTime(auction.endsAt, data?.shop?.ianaTimezone)}, in under an hour. The current bid is ${money(auction.currentBid)}.`,
            winning
              ? "You're currently the high bidder. Keep watching in case someone outbids you."
              : "You're not the high bidder right now. Bid again before time runs out.",
          ],
          buttonLabel: winning ? "Watch the auction" : "Bid again",
          buttonUrl: auctionLink(data),
          shopName: data?.shop?.name || "the store",
          replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
        prefsUrl: data?.prefsUrl,
        });
        console.log("[notify] 1-hour reminder sent", JSON.stringify({ auctionId: auction.id, customerId: bid.bidderId }));
      } catch (error) {
        await releaseNotice({ auctionId: auction.id, customerId: bid.bidderId, type: "ENDING_SOON", key: "1h" });
        console.error("[notify] 1-hour reminder failed:", error?.message || error);
      }
    }
  }
}

if (!globalThis.__HELLFIRE_NOTIFY_STATUS__) {
  globalThis.__HELLFIRE_NOTIFY_STATUS__ = true;
  console.log(
    "[notify] status:",
    notificationsEnabled()
      ? `ON (sending as ${process.env.NOTIFY_FROM})`
      : `OFF (missing: ${[!process.env.RESEND_API_KEY && "RESEND_API_KEY", !process.env.NOTIFY_FROM && "NOTIFY_FROM"].filter(Boolean).join(", ")})`,
  );
}

// Tells the store owner the result of an auction (sold, unsold or reserve not met). Sent once.
export async function notifyMerchantEnded({ auction, winnerId, reserveMet }) {
  if (!notificationsEnabled()) return;
  if (!(await getShopPlan(auction.shop)).emails) return;
  try {
    const fresh = await claimNotice({ auctionId: auction.id, customerId: "merchant", type: "MERCHANT_ENDED", key: "1" });
    if (!fresh) return;
    const { admin } = await unauthenticated.admin(auction.shop);
    const response = await admin.graphql(
      `#graphql
        query EndedLookup($product: ID!, $customer: ID!, $hasWinner: Boolean!) {
          shop { name email contactEmail ianaTimezone currencyCode }
          product(id: $product) { title }
          customer(id: $customer) @include(if: $hasWinner) { email }
        }`,
      {
        variables: {
          product: auction.productId,
          customer: winnerId ? `gid://shopify/Customer/${winnerId}` : "gid://shopify/Customer/0",
          hasWinner: Boolean(winnerId),
        },
      },
    );
    const data = (await response.json())?.data || {};
    useCurrency(data);
    const to = data?.shop?.email || data?.shop?.contactEmail;
    if (!to) return;
    const title = data?.product?.title || auction.title;
    const lines = winnerId
      ? [
          `"${title}" sold for ${money(auction.currentBid)} with ${auction.bidCount} bid${auction.bidCount === 1 ? "" : "s"}.`,
          `Winner: ${data?.customer?.email || "Customer " + winnerId}.`,
          "The winner has been sent a Shopify invoice automatically. You'll see the order once they pay.",
        ]
      : [
          `"${title}" ended without a sale${reserveMet === false ? " because the reserve price wasn't met" : auction.bidCount ? "" : " (no bids)"}.`,
          "You can relist it from the Hellfire Auctions app with one click.",
        ];
    await sendEmail({
      to,
      subject: winnerId ? `Sold: ${title} for ${money(auction.currentBid)}` : `Auction ended: ${title}`,
      heading: winnerId ? "Your auction sold!" : "Your auction ended",
      lines,
      buttonLabel: "Open Hellfire Auctions",
      buttonUrl: `https://admin.shopify.com/store/${auction.shop.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY}`,
      shopName: data?.shop?.name || "your store",
    });
    console.log("[notify] merchant ended email sent", JSON.stringify({ auctionId: auction.id, sold: Boolean(winnerId) }));
  } catch (error) {
    await releaseNotice({ auctionId: auction.id, customerId: "merchant", type: "MERCHANT_ENDED", key: "1" });
    console.error("[notify] merchant ended email failed:", error?.message || error);
  }
}

// Emails the app owner when something important fails (at most once an hour per problem).
const alertSentAt = new Map();
export async function alertOwner(kind, subject, lines) {
  try {
    if (!notificationsEnabled()) return;
    const last = alertSentAt.get(kind) || 0;
    if (Date.now() - last < 60 * 60_000) return;
    alertSentAt.set(kind, Date.now());
    await sendEmail({
      to: process.env.ALERT_EMAIL || "support@hellfireauctions.com",
      subject: "[Hellfire Auctions alert] " + subject,
      heading: subject,
      lines,
      buttonLabel: "Open Render logs",
      buttonUrl: "https://dashboard.render.com/web/srv-dauorhrncjis73fouj8g/logs",
      shopName: "Hellfire Auctions",
    });
    console.log("[alert] sent:", kind);
  } catch (error) {
    console.error("[alert] could not send:", error?.message || error);
  }
}

// Tells the high bidder the auction ended below the reserve: no sale, no charge. Sent once.
export async function notifyReserveNotMet({ auction, customerId }) {
  if (!notificationsEnabled()) return;
  try {
    if (!(await getShopPlan(auction.shop)).emails) return;
    const fresh = await claimNotice({ auctionId: auction.id, customerId, type: "RESERVE_NOT_MET", key: "1" });
    if (!fresh) return;
    try {
      const data = await lookup(auction.shop, customerId, auction.productId);
    useCurrency(data);
      const email = data?.customer?.email;
      if (!email) return;
      const title = data?.product?.title || auction.title;
      await sendEmail({
        to: email,
        subject: `Auction ended: reserve not met \u2014 ${title}`,
        heading: "The reserve wasn't met",
        lines: [
          "Hey there,",
          `The auction for "${title}" has ended. You were the highest bidder at ${money(auction.currentBid)}, but the seller's reserve price wasn't met, so there's no sale and you won't be charged.`,
          "Keep an eye on the store in case the seller relists it.",
        ],
        buttonLabel: "Visit the store",
        buttonUrl: auctionLink(data),
        shopName: data?.shop?.name || "the store",
        replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
        prefsUrl: data?.prefsUrl,
      });
      console.log("[notify] reserve-not-met email sent", JSON.stringify({ auctionId: auction.id, customerId }));
    } catch (error) {
      await releaseNotice({ auctionId: auction.id, customerId, type: "RESERVE_NOT_MET", key: "1" });
      throw error;
    }
  } catch (error) {
    console.error("[notify] reserve-not-met email failed:", error?.message || error);
  }
}

// Backup for the winner's invoice: if Shopify can't email it (e.g. the store's sender
// email isn't verified), send the same secure Shopify checkout link from our address.
export async function sendWinnerInvoiceFallback({ auction, customerId, checkoutUrl, secondChance = false }) {
  if (!notificationsEnabled() || !checkoutUrl) return false;
  try {
    const data = await lookup(auction.shop, customerId, auction.productId);
    useCurrency(data);
    const email = data?.customer?.email;
    if (!email) return false;
    const title = data?.product?.title || auction.title;
    const otherWins = secondChance
      ? 0
      : await prisma.auction.count({
          where: { shop: auction.shop, winnerId: String(customerId), id: { not: auction.id }, winnerNotifiedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } },
        });
    const myAuctionsUrl = data?.shop?.primaryDomain?.url ? `${data.shop.primaryDomain.url.replace(/\/$/, "")}/apps/hellfire-auctions/my-auctions` : null;
    const extraWinsLine = otherWins > 0 && myAuctionsUrl
      ? `You have other recent wins. To pay for everything at once and pay shipping once, open your My Auctions page: ${myAuctionsUrl}`
      : null;
    await sendEmail({
      to: email,
      subject: secondChance ? `A second chance to buy "${title}" at ${data?.shop?.name || "our store"}` : `You won the auction at ${data?.shop?.name || "our store"}!`,
      heading: secondChance ? "A second chance to buy" : "You won the auction!",
      lines: secondChance
        ? [
            "Good news!",
            `The original winner didn't complete the purchase, so "${title}" is now offered to you at ${money(auction.currentBid)}.`,
            "Use the secure checkout link below to buy it. Please pay within 4 days.",
          ]
        : [
            "Hey there,",
            `Congratulations! You won "${title}" with a winning bid of ${money(auction.currentBid)}.`,
            "Use the secure checkout link below to complete your purchase. Please pay within 4 days. At checkout you can choose from all of the shipping options the store offers.",
            ...(extraWinsLine ? [extraWinsLine] : []),
          ],
      buttonLabel: "Complete your purchase",
      buttonUrl: checkoutUrl,
      imageUrl: auction.imageUrl,
      shopName: data?.shop?.name || "the store",
      replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
    });
    console.log("[notify] winner checkout link sent by email", JSON.stringify({ auctionId: auction.id, customerId }));
    return true;
  } catch (error) {
    console.error("[notify] winner checkout email failed:", error?.message || error);
    return false;
  }
}

// The winner's email (once per winner). Returns true if they've been emailed.
export async function notifyWinner({ auction, customerId, checkoutUrl, secondChance = false }) {
  if (!notificationsEnabled() || !customerId || !checkoutUrl) return false;
  const notice = { auctionId: auction.id, customerId: String(customerId), type: "WINNER", key: secondChance ? "second-chance" : "1" };
  try {
    if (!(await claimNotice(notice))) return true; // already sent earlier
    const sent = await sendWinnerInvoiceFallback({ auction, customerId, checkoutUrl, secondChance });
    if (!sent) await releaseNotice(notice);
    return sent;
  } catch (error) {
    await releaseNotice(notice);
    console.error("[notify] winner email failed:", error?.message || error);
    return false;
  }
}

// ---------- unpaid winners ----------
const PAY_WINDOW_HOURS = 96;

// Reminder to the winner (plan-gated, once per key unless the key is unique).
export async function sendPaymentReminder({ auction, key }) {
  if (!notificationsEnabled()) return { sent: false, reason: "off" };
  if (!(await getShopPlan(auction.shop)).emails) return { sent: false, reason: "plan" };
  const notice = { auctionId: auction.id, customerId: String(auction.winnerId), type: "PAY_REMINDER", key };
  if (!(await claimNotice(notice))) return { sent: false, reason: "already" };
  try {
    const data = await lookup(auction.shop, auction.winnerId, auction.productId);
    useCurrency(data);
    const email = data?.customer?.email;
    if (!email || !auction.winnerCheckoutUrl) {
      await releaseNotice(notice);
      return { sent: false, reason: "missing" };
    }
    const title = data?.product?.title || auction.title;
    const base = auction.winnerNotifiedAt || auction.endsAt;
    const sameInvoice = await prisma.auction.findMany({
      where: { shop: auction.shop, winnerDraftOrderId: auction.winnerDraftOrderId },
      select: { currentBid: true },
    });
    const combinedItems = sameInvoice.length > 1;
    const combinedTotal = sameInvoice.reduce((s, x) => s + Number(x.currentBid || 0), 0);
    const due = new Date(new Date(base).getTime() + PAY_WINDOW_HOURS * 3600_000);
    await sendEmail({
      to: email,
      subject: `Reminder: complete your purchase of ${title}`,
      heading: "Your purchase is waiting",
      lines: [
        "Hey there,",
        combinedItems
          ? `You won ${sameInvoice.length} items (${money(combinedTotal)} in total), and your combined purchase isn't complete yet.`
          : `You won "${title}" with a winning bid of ${money(auction.currentBid)}, but your purchase isn't complete yet.`,
        `Please pay by ${friendlyTime(due, data?.shop?.ianaTimezone)} so the seller can ship it to you.`,
      ],
      buttonLabel: "Complete your purchase",
      buttonUrl: auction.winnerCheckoutUrl,
      shopName: data?.shop?.name || "the store",
      replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
    });
    console.log("[notify] payment reminder sent", JSON.stringify({ auctionId: auction.id, key }));
    return { sent: true };
  } catch (error) {
    await releaseNotice(notice);
    console.error("[notify] payment reminder failed:", error?.message || error);
    return { sent: false, reason: "error" };
  }
}

// Tells the store owner the payment deadline passed (once).
export async function notifyMerchantUnpaid({ auction }) {
  if (!notificationsEnabled()) return;
  if (!(await getShopPlan(auction.shop)).emails) return;
  const notice = { auctionId: auction.id, customerId: "merchant", type: "MERCHANT_UNPAID", key: String(auction.winnerId) };
  try {
    if (!(await claimNotice(notice))) return;
    const data = await lookup(auction.shop, auction.winnerId, auction.productId);
    useCurrency(data);
    const to = data?.shop?.email || data?.shop?.contactEmail;
    if (!to) {
      await releaseNotice(notice);
      return;
    }
    const title = data?.product?.title || auction.title;
    await sendEmail({
      to,
      subject: `Unpaid winner: ${title}`,
      heading: "The winner hasn't paid",
      lines: [
        `The payment deadline has passed for "${title}" (winning bid ${money(auction.currentBid)}).`,
        "Open Hellfire Auctions to send another reminder, offer the item to the next bidder, or cancel the sale and relist it.",
      ],
      buttonLabel: "Open Hellfire Auctions",
      buttonUrl: `https://admin.shopify.com/store/${auction.shop.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY}`,
      shopName: data?.shop?.name || "your store",
    });
    console.log("[notify] unpaid-winner alert sent", JSON.stringify({ auctionId: auction.id }));
  } catch (error) {
    await releaseNotice(notice);
    console.error("[notify] unpaid-winner alert failed:", error?.message || error);
  }
}

// After an auction sells, tell the other bidders it ended (once each; plan-gated like other bidder emails).
export async function notifyLosers({ auction }) {
  if (!notificationsEnabled() || !auction.winnerId) return;
  if (!(await getShopPlan(auction.shop)).emails) return;
  const others = await prisma.bid.findMany({
    where: { auctionId: auction.id, NOT: { bidderId: String(auction.winnerId) } },
    select: { bidderId: true },
    take: 50,
  });
  for (const b of others) {
    const notice = { auctionId: auction.id, customerId: String(b.bidderId), type: "LOST", key: "1" };
    try {
      if (!(await claimNotice(notice))) continue;
      const data = await lookup(auction.shop, b.bidderId, auction.productId);
      useCurrency(data);
      const email = data?.customer?.email;
      if (!email) {
        await releaseNotice(notice);
        continue;
      }
      const title = data?.product?.title || auction.title;
      const base = data?.shop?.primaryDomain?.url;
      await sendEmail({
        to: email,
        subject: `Auction ended: ${title}`,
        heading: "This auction has ended",
        lines: [
          "Hey there,",
          `"${title}" sold for ${money(auction.currentBid)}, so your bid didn't win this time.`,
          "Thanks for bidding. There may be more auctions running right now.",
        ],
        buttonLabel: "See live auctions",
        buttonUrl: base ? `${base.replace(/\/$/, "")}/collections/live-auctions` : undefined,
        imageUrl: auction.imageUrl,
        shopName: data?.shop?.name || "the store",
        replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
        prefsUrl: data?.prefsUrl,
      });
      console.log("[notify] did-not-win email sent", JSON.stringify({ auctionId: auction.id, customerId: b.bidderId }));
    } catch (error) {
      await releaseNotice(notice);
      console.error("[notify] did-not-win email failed:", error?.message || error);
    }
  }
}

// Watchers: "starting now" when a scheduled auction goes live.
export async function notifyWatchersStarted({ auction }) {
  if (!notificationsEnabled()) return;
  if (!(await getShopPlan(auction.shop)).emails) return;
  const watchers = await prisma.watch.findMany({ where: { auctionId: auction.id }, select: { customerId: true }, take: 200 });
  for (const w of watchers) {
    const notice = { auctionId: auction.id, customerId: w.customerId, type: "WATCH_START", key: "1" };
    try {
      if (!(await claimNotice(notice))) continue;
      const data = await lookup(auction.shop, w.customerId, auction.productId);
      useCurrency(data);
      const email = data?.customer?.email;
      if (!email) {
        await releaseNotice(notice);
        continue;
      }
      const title = data?.product?.title || auction.title;
      await sendEmail({
        to: email,
        subject: `Now live: ${title}`,
        heading: "The auction you're watching has started",
        lines: [
          "Hey there,",
          `"${title}" is live now at ${money(auction.startingBid)}. It ends ${friendlyTime(auction.endsAt, data?.shop?.ianaTimezone)}.`,
        ],
        buttonLabel: "Bid now",
        buttonUrl: auctionLink(data),
        imageUrl: auction.imageUrl,
        shopName: data?.shop?.name || "the store",
        replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
        prefsUrl: data?.prefsUrl,
      });
      console.log("[notify] watcher start email sent", JSON.stringify({ auctionId: auction.id, customerId: w.customerId }));
    } catch (error) {
      await releaseNotice(notice);
      console.error("[notify] watcher start email failed:", error?.message || error);
    }
  }
}

// Watchers: one hour before the end (bidders already got their own reminder, so they're skipped).
export async function sendWatcherReminders() {
  if (!notificationsEnabled()) return;
  const now = new Date();
  const auctions = await prisma.auction.findMany({
    where: { startsAt: { lte: now }, endsAt: { gt: now, lte: new Date(now.getTime() + ENDING_SOON_MS) }, watches: { some: {} } },
    include: { watches: { select: { customerId: true }, take: 200 } },
    take: 25,
  });
  for (const auction of auctions) {
    if (auction.endsAt.getTime() - auction.startsAt.getTime() <= ENDING_SOON_MS) continue;
    if (!(await getShopPlan(auction.shop)).emails) continue;
    for (const w of auction.watches) {
      const notice = { auctionId: auction.id, customerId: w.customerId, type: "ENDING_SOON", key: "1h" };
      try {
        if (!(await claimNotice(notice))) continue;
        const data = await lookup(auction.shop, w.customerId, auction.productId);
        useCurrency(data);
        const email = data?.customer?.email;
        if (!email) {
          await releaseNotice(notice);
          continue;
        }
        const title = data?.product?.title || auction.title;
        await sendEmail({
          to: email,
          subject: `1 hour left: ${title}`,
          heading: "Less than 1 hour left",
          lines: [
            "Hey there,",
            `The auction you're watching, "${title}", ends at ${friendlyTime(auction.endsAt, data?.shop?.ianaTimezone)}, in under an hour. The current bid is ${money(auction.currentBid)}.`,
          ],
          buttonLabel: "Bid now",
          buttonUrl: auctionLink(data),
          imageUrl: auction.imageUrl,
          shopName: data?.shop?.name || "the store",
          replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
        prefsUrl: data?.prefsUrl,
        });
        console.log("[notify] watcher reminder sent", JSON.stringify({ auctionId: auction.id, customerId: w.customerId }));
      } catch (error) {
        await releaseNotice(notice);
        console.error("[notify] watcher reminder failed:", error?.message || error);
      }
    }
  }
}

// A test auction on a live store ended: tell the merchant who would have won, and that nothing was created.
export async function notifyMerchantTestEnded({ auction, topBidderId }) {
  if (!notificationsEnabled()) return;
  const notice = { auctionId: auction.id, customerId: "merchant", type: "MERCHANT_TEST_ENDED", key: "1" };
  try {
    if (!(await claimNotice(notice))) return;
    const data = await lookup(auction.shop, topBidderId || "0", auction.productId);
    useCurrency(data);
    const to = data?.shop?.email || data?.shop?.contactEmail;
    if (!to) {
      await releaseNotice(notice);
      return;
    }
    const title = data?.product?.title || auction.title;
    await sendEmail({
      to,
      subject: `Test auction finished: ${title}`,
      heading: "Your test auction finished",
      lines: [
        topBidderId && data?.customer?.email
          ? `The top bidder was ${data.customer.email} at ${money(auction.currentBid)}.`
          : "There was no qualifying top bid.",
        "Because this was a test auction, no winner, order or invoice was created, and nobody can pay for it.",
        "For a real sale, create the auction with a length of 24 hours or longer.",
      ],
      shopName: data?.shop?.name || "your store",
    });
    console.log("[notify] test-auction summary sent", JSON.stringify({ auctionId: auction.id }));
  } catch (error) {
    await releaseNotice(notice);
    console.error("[notify] test-auction summary failed:", error?.message || error);
  }
}

// Weekly backup: encrypted (AES-256-GCM) and emailed to the owner. Key = BACKUP_PASSPHRASE, or the app secret if unset.
export async function emailEncryptedBackup({ json, counts }) {
  if (!notificationsEnabled()) return false;
  const secret = process.env.BACKUP_PASSPHRASE || process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;
  const crypto = await import("node:crypto");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const file = Buffer.concat([Buffer.from("HFB1"), salt, iv, cipher.getAuthTag(), encrypted]);
  const day = new Date().toISOString().slice(0, 10);
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM,
      to: [process.env.ALERT_EMAIL || "support@hellfireauctions.com"],
      subject: `Hellfire Auctions weekly backup ${day}`,
      text: `Encrypted weekly backup attached (${counts}). Keep this email. To restore or inspect it, ask Claude to decrypt it; the key is your app's secret unless you set BACKUP_PASSPHRASE.`,
      attachments: [{ filename: `hellfire-backup-${day}.enc`, content: file.toString("base64") }],
    }),
  });
  if (!response.ok) throw new Error(`backup email HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return true;
}

// The theme embed looks switched off: tell the merchant how to fix it.
export async function notifyMerchantEmbedOff({ auction }) {
  if (!notificationsEnabled()) return;
  const data = await lookup(auction.shop, "0", auction.productId);
  const to = data?.shop?.email || data?.shop?.contactEmail;
  if (!to) return;
  const title = data?.product?.title || auction.title;
  await sendEmail({
    to,
    subject: "Action needed: turn on Hellfire Auctions in your theme",
    heading: "Your auction isn't showing on your storefront",
    lines: [
      `Your auction "${title}" is live, but your storefront isn't loading the bidding panel. This usually happens after publishing a new theme.`,
      "Open the theme editor, switch on \"Hellfire Auctions Runtime\" under App embeds, and click Save. Until then shoppers can't bid.",
    ],
    buttonLabel: "Open the theme editor",
    buttonUrl: `https://admin.shopify.com/store/${auction.shop.replace(".myshopify.com", "")}/themes/current/editor?context=apps`,
    shopName: data?.shop?.name || "your store",
  });
}

// The product was deleted in Shopify before the auction settled.
export async function notifyMerchantProductGone({ auction }) {
  if (!notificationsEnabled()) return;
  const data = await lookup(auction.shop, "0", auction.productId);
  const to = data?.shop?.email || data?.shop?.contactEmail;
  if (!to) return;
  await sendEmail({
    to,
    subject: `Auction closed: the product was deleted (${auction.title})`,
    heading: "An auction closed without a winner",
    lines: [
      `The product for the auction "${auction.title}" was deleted from Shopify before the auction ended, so no winner, order or invoice was created.`,
      "Please contact your bidders if needed. To sell the item again, create a new auction.",
    ],
    shopName: data?.shop?.name || "your store",
  });
}

// Shopify "customer data request": send the merchant what the app holds about that customer (no other bidders' data).
export async function emailDataRequest({ shop, customerId, report }) {
  if (!notificationsEnabled()) return;
  const data = await lookup(shop, customerId || "0", "gid://shopify/Product/0");
  const to = data?.shop?.email || data?.shop?.contactEmail;
  if (!to) return;
  const rows = (report.events || []).slice(0, 25).map((e) => `${e.title}: ${Number(e.amount).toFixed(2)} on ${new Date(e.at).toISOString().slice(0, 10)}`);
  await sendEmail({
    to,
    subject: `Customer data request: records held by Hellfire Auctions`,
    heading: "Customer data request",
    lines: [
      `Shopify sent a data request for customer ${customerId}${data?.customer?.email ? ` (${data.customer.email})` : ""}.`,
      `Records held: ${report.bids} bid(s) on ${report.auctions} auction(s), ${report.watches} watch(es), ${report.notices} email notice record(s). Blocked by you: ${report.blocked ? "yes" : "no"}.`,
      rows.length ? `Visible bid amounts: ${rows.join("; ")}` : "No bid amounts are held.",
      "The app stores no name, address or payment details. Please share this with the customer if they asked for it.",
    ],
    shopName: data?.shop?.name || "your store",
  });
}

// The winner could not be invoiced automatically: tell the store owner, once when it first fails and once if the
// app finally gives up. This is an important operational email, so it is not limited by plan.
export async function notifyMerchantSettleFailed({ auction, error, final }) {
  if (!notificationsEnabled()) return;
  if (auction.isTest) return; // tests are the owner's own experiments, not a sale waiting on an invoice
  const notice = { auctionId: auction.id, customerId: "merchant", type: "MERCHANT_SETTLE_FAIL", key: final ? "final" : "first" };
  try {
    if (!(await claimNotice(notice))) return;
    const data = await lookup(auction.shop, "0", auction.productId);
    useCurrency(data);
    const to = data?.shop?.email || data?.shop?.contactEmail;
    if (!to) {
      await releaseNotice(notice);
      return;
    }
    const title = data?.product?.title || auction.title;
    const text = String(error || "");
    const reason = /invalid id|not found|does not exist/i.test(text)
      ? "Shopify could not find the winning customer's account (it may have been deleted or merged)."
      : `Shopify returned an error: ${text.slice(0, 160)}`;
    const lines = final
      ? [
          `"${title}" ended with a winning bid of ${money(auction.currentBid)}, but after 24 hours of trying the app could not create the winner's invoice.`,
          reason,
          "What you can do: open the auction in Hellfire Auctions and use Offer to next bidder, or create a draft order for the winner in Shopify yourself. Contact support@hellfireauctions.com if you'd like help.",
        ]
      : [
          `"${title}" has ended with a winning bid of ${money(auction.currentBid)}, but the app could not create the winner's invoice yet.`,
          reason,
          "The app will keep trying automatically every 2 minutes for 24 hours, and will email you again if it cannot finish. You don't need to do anything right now.",
        ];
    await sendEmail({
      to,
      subject: final ? `Action needed: no invoice for "${title}"` : `Invoice delayed for "${title}"`,
      heading: final ? "We couldn't invoice the winner" : "The winner's invoice is delayed",
      lines,
      buttonLabel: "Open Hellfire Auctions",
      buttonUrl: `https://admin.shopify.com/store/${auction.shop.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY}`,
      shopName: data?.shop?.name || "your store",
    });
  } catch (err) {
    await releaseNotice(notice);
    console.error("[notify] settlement-failure email failed:", err?.message || err);
  }
}

// The 4-day window passed with no payment: tell the store what the app did automatically.
export async function notifyMerchantAutoOffer({ auction, price, strikes, blocked }) {
  if (!notificationsEnabled()) return;
  if (!(await getShopPlan(auction.shop)).emails) return;
  const notice = { auctionId: auction.id, customerId: "merchant", type: "MERCHANT_AUTO_OFFER", key: "1" };
  try {
    if (!(await claimNotice(notice))) return;
    const data = await lookup(auction.shop, "0", auction.productId);
    useCurrency(data);
    const to = data?.shop?.email || data?.shop?.contactEmail;
    if (!to) {
      await releaseNotice(notice);
      return;
    }
    const title = data?.product?.title || auction.title;
    const plural = (n) => `${n} unpaid sale${n === 1 ? "" : "s"}`;
    const lines = [`The winner of "${title}" didn't pay within 4 days, so the item was offered to the next bidder automatically at ${money(price)}.`];
    if (blocked) lines.push(`The first winner has ${plural(strikes)} on record and was blocked from bidding automatically. You can unblock them in Hellfire Auctions.`);
    else if (strikes > 0) lines.push(`The first winner now has ${plural(strikes)} on record.`);
    lines.push("You can change this under Unpaid winners in Hellfire Auctions.");
    await sendEmail({
      to,
      subject: `Offered to the next bidder: ${title}`,
      heading: "Second-chance offer sent",
      lines,
      buttonLabel: "Open Hellfire Auctions",
      buttonUrl: `https://admin.shopify.com/store/${auction.shop.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY}`,
      shopName: data?.shop?.name || "your store",
    });
  } catch (error) {
    await releaseNotice(notice);
    console.error("[notify] automatic second-chance email failed:", error?.message || error);
  }
}

// The buyer's wins were merged into one invoice (seller pressed "Combine").
export async function notifyCombinedInvoice({ shop, customerId, count, total, url }) {
  if (!notificationsEnabled()) return;
  const data = await lookup(shop, customerId, "gid://shopify/Product/0");
  useCurrency(data);
  const email = data?.customer?.email;
  if (!email) return;
  await sendEmail({
    to: email,
    subject: `Your ${count} items are on one invoice`,
    heading: "One invoice for all your wins",
    lines: [
      "Hey there,",
      `We combined your ${count} unpaid wins into one invoice (${money(total)} before shipping and tax), so you only pay shipping once.`,
      "Your earlier separate invoice links no longer work. Please use the button below and pay within 4 days.",
    ],
    buttonLabel: "Pay all wins together",
    buttonUrl: url,
    shopName: data?.shop?.name || "the store",
    replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
  });
}

// A new win was added to the buyer's unpaid COMBINED invoice.
export async function notifyJoinedInvoice({ shop, customerId, title, count, total, url }) {
  if (!notificationsEnabled()) return;
  const data = await lookup(shop, customerId, "gid://shopify/Product/0");
  useCurrency(data);
  const email = data?.customer?.email;
  if (!email) return;
  await sendEmail({
    to: email,
    subject: `Added to your invoice: ${title}`,
    heading: "Another win added to your invoice",
    lines: [
      "Hey there,",
      `You won "${title}". We added it to your open invoice, so you pay shipping only once.`,
      `Your invoice now has ${count} items (${money(total)} before shipping and tax). Your 4-day payment window restarted today.`,
    ],
    buttonLabel: "Pay all wins together",
    buttonUrl: url,
    shopName: data?.shop?.name || "the store",
    replyTo: data?.shop?.contactEmail,
        lang: data?.lang,
  });
}
