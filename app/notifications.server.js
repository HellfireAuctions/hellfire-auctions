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
        shop { name contactEmail ianaTimezone currencyCode primaryDomain { url } }
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

async function sendEmail({ to, subject, heading, lines, buttonLabel, buttonUrl, shopName, replyTo }) {
  const htmlLines = lines.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join("");
  const button = buttonUrl
    ? `<p style="margin:20px 0"><a href="${escapeHtml(buttonUrl)}" style="background:#ff3b30;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${escapeHtml(buttonLabel)}</a></p>`
    : "";
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#151515">
    <h2 style="margin:0 0 16px">${escapeHtml(heading)}</h2>${htmlLines}${button}
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
export async function sendWinnerInvoiceFallback({ auction, customerId, checkoutUrl }) {
  if (!notificationsEnabled() || !checkoutUrl) return false;
  try {
    const data = await lookup(auction.shop, customerId, auction.productId);
    useCurrency(data);
    const email = data?.customer?.email;
    if (!email) return false;
    const title = data?.product?.title || auction.title;
    await sendEmail({
      to: email,
      subject: `You won the auction at ${data?.shop?.name || "our store"}!`,
      heading: "You won the auction!",
      lines: [
        "Hey there,",
        `Congratulations! You won "${title}" with a winning bid of ${money(auction.currentBid)}.`,
        "Use the secure Shopify checkout link below to complete your purchase.",
      ],
      buttonLabel: "Complete your purchase",
      buttonUrl: checkoutUrl,
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

// Always email the winner their checkout link (once), in addition to Shopify's own invoice.
export async function notifyWinner({ auction, customerId, checkoutUrl }) {
  if (!notificationsEnabled() || !customerId || !checkoutUrl) return;
  const notice = { auctionId: auction.id, customerId: String(customerId), type: "WINNER", key: "1" };
  try {
    if (!(await claimNotice(notice))) return;
    const sent = await sendWinnerInvoiceFallback({ auction, customerId, checkoutUrl });
    if (!sent) await releaseNotice(notice);
  } catch (error) {
    await releaseNotice(notice);
    console.error("[notify] winner email failed:", error?.message || error);
  }
}
