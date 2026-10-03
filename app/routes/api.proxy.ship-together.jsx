import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { requestShipTogether } from "../auction-worker.server";

// A signed-in buyer asks to ship their unpaid wins together with an existing order.
const lastTry = new Map();

export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
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

  const form = await request.formData();
  const orderRef = (form.get("order") || "").toString().trim().replace(/[^#A-Za-z0-9 \-]/g, "").slice(0, 30);
  if (!orderRef) return Response.json({ error: "Please enter your order number, for example #1042." }, { status: 400 });

  const result = await requestShipTogether(shop, customerId, orderRef);
  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ message: result.message });
};
