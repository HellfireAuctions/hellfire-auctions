import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // The app can no longer reach this store, so stop its open auctions. Otherwise the worker would keep
  // trying to start and settle them (and a reinstall would find them half-finished).
  try {
    const stopped = await db.auction.updateMany({
      where: { shop, status: { in: ["DRAFT", "UPCOMING", "LIVE"] } },
      data: { status: "CANCELLED" },
    });
    if (stopped.count) console.log(`[uninstall] stopped ${stopped.count} open auction(s) for ${shop}`);
  } catch (error) {
    console.error("[uninstall] could not stop open auctions:", error?.message || error);
  }

  return new Response();
};
