// "Who can bid": the merchant's rule and the decision for one customer. Pure functions, so they are easy to test.
//
//   ANYONE         anyone who is signed in (the default, and what the app has always done)
//   VERIFIED_EMAIL only customers whose email address Shopify has verified
//   PAST_BUYER     only customers with at least one earlier order in this store
//   APPROVED_TAG   only customers the merchant has tagged as approved
export const BIDDER_RULES = {
  ANYONE: "Anyone who is signed in",
  VERIFIED_EMAIL: "Only customers with a verified email address",
  PAST_BUYER: "Only customers who have bought from my store before",
  APPROVED_TAG: "Only customers I've approved with a tag",
};
export const BIDDER_RULE_VALUES = Object.keys(BIDDER_RULES);
export const DEFAULT_APPROVED_TAG = "bidder-approved";

export const MESSAGES = {
  unavailable: "We couldn't check your account right now. Please try again in a moment.",
  VERIFIED_EMAIL: "To bid in this store, your account needs a verified email address. Please sign out and sign back in, or contact the store.",
  PAST_BUYER: "This store only accepts bids from customers who have bought here before. Please contact the store to be approved.",
  APPROVED_TAG: "Bidding in this store is limited to approved bidders. Please contact the store to be approved.",
};

// A tag is plain words: letters, numbers, spaces and - _ : . only, up to 40 characters. Anything else is rejected.
export function cleanTag(value) {
  const tag = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return /^[\p{L}\p{N} _\-:.]+$/u.test(tag) ? tag : "";
}

// customer: { verifiedEmail, numberOfOrders, tags } as Shopify reports it, or null when it could not be found.
// An unknown rule is treated as "anyone", so a corrupted setting can never lock a merchant out of their own auctions.
export function decide(rule, approvedTag, customer) {
  if (!BIDDER_RULE_VALUES.includes(rule) || rule === "ANYONE") return { ok: true };
  if (!customer || typeof customer !== "object") return { ok: false, message: MESSAGES.unavailable };
  if (rule === "VERIFIED_EMAIL") {
    return customer.verifiedEmail === true ? { ok: true } : { ok: false, message: MESSAGES.VERIFIED_EMAIL };
  }
  if (rule === "PAST_BUYER") {
    return Number(customer.numberOfOrders) >= 1 ? { ok: true } : { ok: false, message: MESSAGES.PAST_BUYER };
  }
  const wanted = (cleanTag(approvedTag) || DEFAULT_APPROVED_TAG).toLowerCase();
  const tags = Array.isArray(customer.tags) ? customer.tags.map((t) => String(t).trim().toLowerCase()) : [];
  return tags.includes(wanted) ? { ok: true } : { ok: false, message: MESSAGES.APPROVED_TAG };
}
