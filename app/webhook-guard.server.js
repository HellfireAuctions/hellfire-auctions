import crypto from "node:crypto";

// Shopify sends webhooks (uninstall, and the three privacy ones) that must be answered correctly:
//   401  the signature is wrong
//   400  the request is not a proper webhook (missing headers, or a body that cannot be read)
//   200  handled
//   500  a real internal failure, so Shopify retries (and we log why, so it is never a silent 500)
//
// Shopify's library checks the signature and then, before our code runs, refreshes the store's saved access token when it is
// close to expiring. For a store that has uninstalled or been deleted that refresh fails and the library answers 500, so
// Shopify kept retrying an uninstall or a privacy-erasure notice that we never even saw. These webhooks do not need a token,
// so when the library fails that way we check the signature ourselves and carry on.

function verifyByHand(req, raw) {
  const secret = process.env.SHOPIFY_API_SECRET || "";
  const given = req.headers.get("x-shopify-hmac-sha256") || "";
  const shop = req.headers.get("x-shopify-shop-domain") || "";
  const topic = req.headers.get("x-shopify-topic") || "";
  if (!secret || !given || !shop || !topic) throw new Response("Bad request", { status: 400 });
  const expected = crypto.createHmac("sha256", secret).update(raw, "utf8").digest();
  let ok = false;
  try {
    const sent = Buffer.from(given, "base64");
    ok = sent.length === expected.length && crypto.timingSafeEqual(sent, expected);
  } catch {
    ok = false;
  }
  if (!ok) throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  return { shop, topic, payload, session: undefined, admin: undefined, apiVersion: req.headers.get("x-shopify-api-version") || undefined, webhookId: req.headers.get("x-shopify-webhook-id") || undefined };
}

export async function readWebhook(request, authenticate) {
  const copy = request.clone();
  try {
    return await authenticate.webhook(request);
  } catch (error) {
    // Shopify's own plain answers (wrong signature, not a webhook, wrong method) stay exactly as they are
    if (error instanceof Response && error.status < 500) throw error;
    const why = error instanceof Response ? `HTTP ${error.status}` : error?.message || String(error);
    if (request.method !== "POST") throw new Response(undefined, { status: 405, statusText: "Method not allowed" });
    const context = verifyByHand(copy, await copy.text());
    console.warn(`[webhook] the library could not prepare this store's session (${why}); the signature was checked here instead: ${context.shop} ${context.topic}`);
    return context;
  }
}

// Runs the handler's work. A real failure is logged with its reason, then answered 500 so Shopify retries.
export async function guardWebhook(label, work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error(`[webhook] ${label} failed:`, error?.message || error);
    throw new Response("Error", { status: 500 });
  }
}
