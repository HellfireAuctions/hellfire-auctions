import { authenticate } from "../shopify.server";
import db from "../db.server";

// Shopify's three mandatory privacy webhooks (required for App Store apps):
// customers/data_request, customers/redact, shop/redact.
// authenticate.webhook() verifies the HMAC and returns 401 for invalid requests.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const normalized = String(topic).replaceAll("/", "_").toUpperCase();

  switch (normalized) {
    case "CUSTOMERS_DATA_REQUEST": {
      const customerId = String(payload?.customer?.id ?? "");
      const bidCount = customerId
        ? await db.bid.count({ where: { bidderId: customerId, auction: { shop } } })
        : 0;
      // We only store the customer's numeric ID, their bid amounts and timestamps.
      console.log(`[compliance] data request for ${shop}: ${bidCount} bid record(s)`);
      break;
    }

    case "CUSTOMERS_REDACT": {
      const customerId = String(payload?.customer?.id ?? "");
      if (customerId) {
        await db.bid.deleteMany({ where: { bidderId: customerId, auction: { shop } } });
        await db.auction.updateMany({
          where: { shop, winnerId: { in: [customerId, `gid://shopify/Customer/${customerId}`] } },
          data: { winnerId: null },
        });
      }
      console.log(`[compliance] customer redacted for ${shop}`);
      break;
    }

    case "SHOP_REDACT": {
      await db.auction.deleteMany({ where: { shop } }); // bids cascade
      await db.session.deleteMany({ where: { shop } });
      console.log(`[compliance] shop data erased for ${shop}`);
      break;
    }

    default:
      console.log(`[compliance] unhandled topic ${topic} for ${shop}`);
  }

  return new Response();
};
