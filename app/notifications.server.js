// Bidder notifications: "you've been outbid" and "1 hour left".
// Switched OFF automatically until RESEND_API_KEY and NOTIFY_FROM are set on the server.
// Every send is recorded, so a customer never gets the same notice twice.
import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";

const RESEND_URL = "https://api.resend.com/emails";
const OUTBID_WINDOW_MS = 10 * 60_000; // at most one outbid email per bidder per auction per 10 minutes
const ENDING_SOON_MS = 60 * 60_000;

export function notificationsEnabled() {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM);
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
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
        customer(id: $customer) { email firstName }
        product(id: $product) { title onlineStoreUrl }
        shop { name }
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

async function sendEmail({ to, subject, heading, lines, buttonLabel, buttonUrl, shopName }) {
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
      reply_to: process.env.NOTIFY_REPLY_TO || undefined,
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
    const key = String(Math.floor(Date.now() / OUTBID_WINDOW_MS));
    const fresh = await claimNotice({ auctionId: auction.id, customerId: outbidCustomerId, type: "OUTBID", key });
    if (!fresh) return;

    const data = await lookup(shop, outbidCustomerId, auction.productId);
    const email = data?.customer?.email;
    if (!email) return;

    const title = data?.product?.title || auction.title;
    await sendEmail({
      to: email,
      subject: `You've been outbid on ${title}`,
      heading: "You've been outbid",
      lines: [
        `Hi ${data?.customer?.firstName || "there"},`,
        `Someone placed a higher bid on "${title}". The current bid is now ${money(currentBid)}.`,
        `The auction ends ${new Date(auction.endsAt).toUTCString()}.`,
      ],
      buttonLabel: "Bid again",
      buttonUrl: data?.product?.onlineStoreUrl,
      shopName: data?.shop?.name || "the store",
    });
    console.log("[notify] outbid email sent", JSON.stringify({ auctionId: auction.id, customerId: outbidCustomerId }));
  } catch (error) {
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
    const leaderId = auction.bids[0]?.bidderId;
    for (const bid of auction.bids) {
      try {
        const fresh = await claimNotice({ auctionId: auction.id, customerId: bid.bidderId, type: "ENDING_SOON", key: "1h" });
        if (!fresh) continue;

        const data = await lookup(auction.shop, bid.bidderId, auction.productId);
        const email = data?.customer?.email;
        if (!email) continue;

        const title = data?.product?.title || auction.title;
        const winning = bid.bidderId === leaderId;
        await sendEmail({
          to: email,
          subject: `1 hour left: ${title}`,
          heading: "Less than 1 hour left",
          lines: [
            `Hi ${data?.customer?.firstName || "there"},`,
            `The auction for "${title}" ends in under an hour. The current bid is ${money(auction.currentBid)}.`,
            winning
              ? "You're currently the high bidder. Keep watching in case someone outbids you."
              : "You're not the high bidder right now. Bid again before time runs out.",
          ],
          buttonLabel: winning ? "Watch the auction" : "Bid again",
          buttonUrl: data?.product?.onlineStoreUrl,
          shopName: data?.shop?.name || "the store",
        });
        console.log("[notify] 1-hour reminder sent", JSON.stringify({ auctionId: auction.id, customerId: bid.bidderId }));
      } catch (error) {
        console.error("[notify] 1-hour reminder failed:", error?.message || error);
      }
    }
  }
}
