import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopPlan } from "../plans.server";

// Toggles "watching" for the signed-in shopper on a running auction.
const lastTry = new Map();

export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!customerId) return Response.json({ error: "Please sign in." }, { status: 401 });
  if (Date.now() - (lastTry.get(customerId) || 0) < 1000) {
    return Response.json({ error: "Please wait a moment." }, { status: 429 });
  }
  if (lastTry.size > 10000) lastTry.clear();
  lastTry.set(customerId, Date.now());

  const form = await request.formData();
  const raw = (form.get("product_id") || "").toString();
  const productId = raw.startsWith("gid://") ? raw : "gid://shopify/Product/" + raw.replace(/\D/g, "");
  if (!shop || productId.endsWith("/")) return Response.json({ error: "Missing item." }, { status: 400 });

  if (!(await getShopPlan(shop)).emails) {
    return Response.json({ error: "Watching isn't available for this store." }, { status: 403 });
  }

  const a = await prisma.auction.findFirst({ where: { shop, productId }, orderBy: { createdAt: "desc" } });
  if (!a || new Date() >= a.endsAt) return Response.json({ error: "This auction isn't running." }, { status: 404 });

  const existing = await prisma.watch.findUnique({ where: { auctionId_customerId: { auctionId: a.id, customerId } } });
  if (existing) {
    await prisma.watch.delete({ where: { id: existing.id } });
    return Response.json({ watching: false });
  }
  await prisma.watch.create({ data: { shop, auctionId: a.id, customerId } });
  return Response.json({ watching: true });
};
