import { unauthenticated } from "./shopify.server";
import { memo } from "./memo.server";
import { decide, MESSAGES } from "./bidder-rules.js";

async function fetchCustomer(shop, customerId) {
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(
    `#graphql
      query BidderCheck($id: ID!) { customer(id: $id) { verifiedEmail numberOfOrders tags } }`,
    { variables: { id: `gid://shopify/Customer/${customerId}` } },
  );
  const json = await response.json();
  if (json?.errors?.length) throw new Error(json.errors.map((e) => e.message).join(", "));
  return json?.data?.customer || null;
}

// Is this customer allowed to bid under the store's rule? With the default rule there is no lookup at all.
// Otherwise Shopify is asked once a minute per customer. If Shopify can't be reached the bid is refused with a
// friendly "try again" message: the merchant chose the rule, so it is never silently skipped.
export async function checkBidder(shop, customerId, rule, approvedTag) {
  if (!rule || rule === "ANYONE") return { ok: true };
  try {
    const customer = await memo(`bidder:${shop}|${customerId}`, 60_000, () => fetchCustomer(shop, customerId));
    return decide(rule, approvedTag, customer);
  } catch (error) {
    console.error("[bidder-rules] could not check the bidder:", error?.message || error);
    return { ok: false, message: MESSAGES.unavailable };
  }
}
