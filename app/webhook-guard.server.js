// Shopify sends webhooks (uninstall, and the three privacy ones) that must be answered correctly:
//   401  the signature is wrong (Shopify's library answers this itself)
//   400  the request is not a proper webhook (missing headers, or a body that cannot be read)
//   200  handled
//   500  a real internal failure, so Shopify retries (and we log why, so it is never a silent 500)
// Without this, a correctly signed request with an unreadable body made Shopify's library throw an ordinary error, which
// came out as a silent 500.

export async function readWebhook(request, authenticate) {
  try {
    return await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) throw error; // Shopify's own 401 / 400 answers pass through untouched
    console.error("[webhook] could not read the request:", error?.message || error);
    throw new Response("Bad request", { status: 400 });
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
