import { proxyAuth } from "../proxy-auth.server";
import { memo, memoDelete } from "../memo.server";
import prisma from "../db.server";
import { publish } from "../live-hub.server";
import { checkBidder } from "../bidder-rules.server";
import { getShopSettings } from "../settings.server";
import { claimDrop, checkoutFor } from "../action-sale.server";
import { noteDropActivity } from "../drops-followup.server";
import { unauthenticated } from "../shopify.server";

// A shopper taps CLAIM (first tap wins) or CHECKOUT, from the Live Drops room. Signed by Shopify like every
// app proxy request, so the customer is whoever Shopify says is logged in.
const lastTap = new Map();
const TAP_GAP_MS = 250;
const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const action = async ({ request }) => {
  const { session } = await proxyAuth(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");
  if (!shop) return reply({ ok: false, message: "Store not found." }, 400);
  if (!customerId) return reply({ ok: false, message: "Please log in to claim." }, 401);

  // the same people-rules as bidding: blocked shoppers, and the store's "who can bid" rule
  const blocked = await prisma.blockedBidder.findUnique({ where: { shop_customerId: { shop, customerId } } });
  if (blocked) return reply({ ok: false, message: "You can't claim items from this store." }, 403);
  const rules = await memo("settings:" + shop, 10_000, () => getShopSettings(shop));
  const verdict = await checkBidder(shop, customerId, rules.bidderRule, rules.approvedTag);
  if (!verdict.ok) return reply({ ok: false, message: verdict.message }, 403);

  const last = lastTap.get(customerId) || 0;
  if (Date.now() - last < TAP_GAP_MS) return reply({ ok: false, message: "One moment..." }, 429);
  if (lastTap.size > 10000) lastTap.clear();
  lastTap.set(customerId, Date.now());

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const saleId = String(form.get("sale") || "");

  if (intent === "claim") {
    const result = await claimDrop({ shop, dropId: String(form.get("drop") || ""), customerId });
    if (result.ok) {
      memoDelete("action:" + result.saleId); // everyone sees the new count on their next refresh
      publish("sale-" + result.saleId, "update");
      noteDropActivity(); // keeps the automatic-invoice timer awake while claims are fresh
      console.log("[HELLFIRE LIVE DROPS]", JSON.stringify({ claim: result.title, left: result.remaining }));
    }
    return reply(result, result.ok ? 200 : result.code === "NOT_FOUND" ? 404 : 409);
  }

  if (intent === "checkout") {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const result = await checkoutFor({ shop, saleId, customerId, admin });
      return reply(result, result.ok ? 200 : 409);
    } catch (error) {
      console.error("[HELLFIRE LIVE DROPS] checkout failed:", saleId, error?.message || error);
      return reply({ ok: false, message: "We couldn't open checkout just now. Please try again in a moment." }, 500);
    }
  }
  return reply({ ok: false, message: "Unknown request." }, 400);
};

export const loader = async () => reply({ ok: false, message: "Not found." }, 404);
