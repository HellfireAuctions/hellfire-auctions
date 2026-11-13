// Shopify is slow to record a cancellation: a subscription we JUST cancelled can still be reported as ACTIVE for several seconds
// (the CANCELLED notice has been seen about 13 seconds later). If the plans page asked Shopify straight away, it would hear
// "still active" and flip the merchant back to the plan they just left. So we remember what we cancelled for a while and ignore it,
// and after an approval we trust the specific charge Shopify just sent us back with.

const RECENT_MS = 15 * 60 * 1000;
const cancelled = new Map();

const tail = (id) => String(id || "").split("/").pop();

export function markSubscriptionCancelled(shop, id, now = Date.now()) {
  if (shop && id) cancelled.set(shop + "|" + tail(id), now);
}

export function isRecentlyCancelled(shop, id, now = Date.now()) {
  const key = shop + "|" + tail(id);
  const at = cancelled.get(key);
  if (at === undefined) return false;
  if (now - at > RECENT_MS) {
    cancelled.delete(key);
    return false;
  }
  return true;
}

// Which subscription is really in force? Active ones, minus anything we just cancelled; if several remain (an upgrade or downgrade
// still settling) prefer the one Shopify has just sent the merchant back with.
export function pickActiveSubscription(subscriptions, { shop, chargeId = null, now = Date.now() } = {}) {
  const live = (subscriptions || []).filter((s) => s && s.status === "ACTIVE" && !isRecentlyCancelled(shop, s.id, now));
  const wanted = chargeId ? live.find((s) => tail(s.id) === tail(chargeId)) : null;
  return wanted || live[0] || null;
}

export function resetCancelledForTests() {
  cancelled.clear();
}
