import { proxyAuth } from "../proxy-auth.server";
import prisma from "../db.server";
import { combineWinnerInvoices } from "../auction-worker.server";

// The signed-in buyer merges their own unpaid wins into one invoice.
const lastTry = new Map();

export const action = async ({ request }) => {
  const { session } = await proxyAuth(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!shop || !customerId) return Response.json({ error: "Please sign in." }, { status: 401 });
  if (Date.now() - (lastTry.get(customerId) || 0) < 3000) {
    return Response.json({ error: "Please wait a moment and try again." }, { status: 429 });
  }
  if (lastTry.size > 10000) lastTry.clear();
  lastTry.set(customerId, Date.now());

  const blocked = await prisma.blockedBidder.findUnique({ where: { shop_customerId: { shop, customerId } } });
  if (blocked) return Response.json({ error: "You can't do that on this store." }, { status: 403 });

  const result = await combineWinnerInvoices(shop, customerId, { notifyBuyer: false });
  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ url: result.url, count: result.count });
};
