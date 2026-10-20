import { authenticate } from "../shopify.server";
import db from "../db.server";
import { stopShopLiveDrops } from "../live-drops-erasure.server";
import { readWebhook, guardWebhook } from "../webhook-guard.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await readWebhook(request, authenticate);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await guardWebhook("uninstall (removing the store's access)", () => db.session.deleteMany({ where: { shop } }));
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

  // Live shows are stopped too (and any running video channel is shut down), for the same reason.
  try {
    const live = await stopShopLiveDrops({ shop });
    if (live.stopped || live.channels) console.log(`[uninstall] stopped ${live.stopped} live show(s) and ${live.channels} video channel(s) for ${shop}`);
  } catch (error) {
    console.error("[uninstall] could not stop live shows:", error?.message || error);
  }

  return new Response();
};
