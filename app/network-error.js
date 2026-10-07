// Is this error just "the connection dropped" (laptop asleep, wifi blip, the server restarting)?
// Those must never turn a page into a full-screen error; the page should reconnect by itself.
// A real answer from the server (a 404, a 500, a thrown response) is NOT a network error and is handled as before.
export function isNetworkError(error) {
  if (!error || typeof error !== "object") return false;
  if (typeof error.status === "number" || "data" in error) return false; // a response from the server
  const message = String(error.message || "");
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|the internet connection appears to be offline/i.test(message);
}

// Did Shopify's login token go missing or expire (the admin tab was idle, or the admin session refreshed)?
// The server answers 401 in that case. It is not a bug and not the merchant's fault: reloading fixes it.
export function isSessionExpired(error) {
  return Boolean(error) && typeof error === "object" && error.status === 401;
}

// Reload at most once every 30 seconds, so a persistent problem can never turn into a reload loop.
export function mayReauth(lastAttemptMs, nowMs = Date.now()) {
  const last = Number(lastAttemptMs);
  return !Number.isFinite(last) || last <= 0 || nowMs - last > 30_000;
}
