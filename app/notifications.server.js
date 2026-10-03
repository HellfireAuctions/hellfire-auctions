// Bidder notifications: "you've been outbid" and "1 hour left".
// Switched OFF automatically until RESEND_API_KEY and NOTIFY_FROM are set on the server.
// Every send is recorded, so a customer never gets the same notice twice.
import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";
import { getShopPlan } from "./plans.server.js";

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

async function lookup(shop, customerId, productId) {
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
async function releaseNotice({ auctionId, customerId, type, key }) {
  try {
    await prisma.auctionNotification.deleteMany({ where: { auctionId, customerId: String(customerId), type, key } });
  } catch {}
}

async function claimNotice({ auctionId, customerId, type, key }) {
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

async function sendEmailRaw({ to, subject, heading, lines, buttonLabel, buttonUrl, shopName, replyTo, imageUrl }) {
  const htmlLines = lines.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join("");
  const button = buttonUrl
    ? `<p style="margin:20px 0"><a href="${escapeHtml(buttonUrl)}" style="background:#ff3b30;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${escapeHtml(buttonLabel)}</a></p>`
    : "";
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#151515">
    ${imageUrl && /^https:\/\//.test(imageUrl) ? `<p style="margin:0 0 16px"><img src="${escapeHtml(imageUrl)}" alt="" style="max-width:100%;max-height:320px;border-radius:10px;display:block"></p>` : ""}<h2 style="margin:0 0 16px">${escapeHtml(heading)}</h2>${htmlLines}${button}
    <p style="margin:24px 0 0;font-size:12px;color:#777">Sent by ${escapeHtml(shopName)} via Hellfire Auctions because you bid on this auction.</p>
  </div>`;
  const text = [heading, "", ...lines, buttonUrl ? `\n${buttonLabel}: ${buttonUrl}` : ""].join("\n");

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
            "Use the secure checkout link below to complete your purchase. Please pay within 4 days.",
          ],
      buttonLabel: "Complete your purchase",
      buttonUrl: checkoutUrl,
      imageUrl: auction.imageUrl,
      shopName: data?.shop?.name || "the store",
      replyTo: data?.shop?.contactEmail,
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
    const due = new Date(new Date(base).getTime() + PAY_WINDOW_HOURS * 3600_000);
    await sendEmail({
      to: email,
      subject: `Reminder: complete your purchase of ${title}`,
      heading: "Your purchase is waiting",
      lines: [
        "Hey there,",
        `You won "${title}" with a winning bid of ${money(auction.currentBid)}, but your purchase isn't complete yet.`,
        `Please pay by ${friendlyTime(due, data?.shop?.ianaTimezone)} so the seller can ship it to you.`,
      ],
      buttonLabel: "Complete your purchase",
      buttonUrl: auction.winnerCheckoutUrl,
      shopName: data?.shop?.name || "the store",
      replyTo: data?.shop?.contactEmail,
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
