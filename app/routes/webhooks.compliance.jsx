import { authenticate } from "../shopify.server";
import db from "../db.server";
import { emailDataRequest } from "../notifications.server";

// Shopify's three mandatory privacy webhooks (required for App Store apps):
// customers/data_request, customers/redact, shop/redact.
// authenticate.webhook() verifies the HMAC and returns 401 for invalid requests.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const normalized = String(topic).replaceAll("/", "_").toUpperCase();

  switch (normalized) {
    case "CUSTOMERS_DATA_REQUEST": {
      const customerId = String(payload?.customer?.id ?? "");
      if (customerId) {
        const events = await db.bidEvent.findMany({
          where: { bidderId: customerId, auction: { shop } },
          orderBy: { createdAt: "asc" },
          take: 200,
          select: { amount: true, createdAt: true, auction: { select: { title: true } } },
        });
        const report = {
          bids: await db.bid.count({ where: { bidderId: customerId, auction: { shop } } }),
          auctions: new Set(events.map((e) => e.auction?.title)).size,
          watches: await db.watch.count({ where: { customerId, shop } }),
          notices: await db.auctionNotification.count({ where: { customerId } }),
          blocked: Boolean(await db.blockedBidder.findUnique({ where: { shop_customerId: { shop, customerId } } })),
          events: events.map((e) => ({ title: e.auction?.title || "Auction", amount: e.amount, at: e.createdAt })),
        };
        await emailDataRequest({ shop, customerId, report }).catch((error) => console.error("[compliance] data request email failed:", error?.message || error));
      }
      console.log(`[compliance] data request handled for ${shop}`);
      break;
    }

    case "CUSTOMERS_REDACT": {
      const customerId = String(payload?.customer?.id ?? "");
      if (customerId) {
        await db.bid.deleteMany({ where: { bidderId: customerId, auction: { shop } } });
      await db.bidEvent.deleteMany({ where: { bidderId: customerId, auction: { shop } } });
      await db.watch.deleteMany({ where: { customerId, shop } });
        await db.blockedBidder.deleteMany({ where: { customerId, shop } });
        await db.auctionNotification.deleteMany({ where: { customerId } });
        await db.auction.updateMany({
          where: { shop, winnerId: { in: [customerId, `gid://shopify/Customer/${customerId}`] } },
          data: { winnerId: null },
        });
      }
      console.log(`[compliance] customer redacted for ${shop}`);
      break;
    }

    case "SHOP_REDACT": {
      const auctionIds = (await db.auction.findMany({ where: { shop }, select: { id: true } })).map((a) => a.id);
      await db.auctionNotification.deleteMany({ where: { auctionId: { in: auctionIds } } });
      await db.auction.deleteMany({ where: { shop } }); // bids cascade
      await db.session.deleteMany({ where: { shop } });
      await db.shopPlan.deleteMany({ where: { shop } });
      await db.blockedBidder.deleteMany({ where: { shop } });
      await db.watch.deleteMany({ where: { shop } });
      console.log(`[compliance] shop data erased for ${shop}`);
      break;
    }

    default:
      console.log(`[compliance] unhandled topic ${topic} for ${shop}`);
  }

  return new Response();
};
