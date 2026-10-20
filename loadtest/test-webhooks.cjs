// Reproduces what Shopify's review automation does to the webhook endpoints: correctly signed deliveries (including for a store the
// app no longer has a session for) and badly signed ones. Uses fake stores for the privacy topics, so it changes nothing real.
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const HOST = "hellfire-auctions.onrender.com";

function send(route, topic, shop, payload, { badSignature = false, noHeaders = false } = {}) {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
  if (!noHeaders) {
    Object.assign(headers, {
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2025-10",
      "X-Shopify-Webhook-Id": crypto.randomUUID(),
      "X-Shopify-Hmac-Sha256": badSignature ? crypto.createHmac("sha256", "wrong-secret").update(body).digest("base64") : hmac,
    });
  }
  return new Promise((resolve) => {
    const req = https.request({ host: HOST, path: route, method: "POST", headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b.slice(0, 120) }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  const fake = "zz-webhook-test.myshopify.com";
  const reviewer = "asa5ve-kz.myshopify.com"; // the reviewer's store: the app has no session for it any more
  const cases = [
    ["uninstalled, signed, fake store            ", "/webhooks/app/uninstalled", "app/uninstalled", fake, { id: 1, name: "t", domain: fake }, {}],
    ["uninstalled, signed, REVIEWER'S store      ", "/webhooks/app/uninstalled", "app/uninstalled", reviewer, { id: 2, name: "Alpha", domain: reviewer }, {}],
    ["uninstalled, WRONG signature               ", "/webhooks/app/uninstalled", "app/uninstalled", fake, { id: 1 }, { badSignature: true }],
    ["uninstalled, no Shopify headers at all     ", "/webhooks/app/uninstalled", "app/uninstalled", fake, { id: 1 }, { noHeaders: true }],
    ["data request, signed, fake store           ", "/webhooks/compliance", "customers/data_request", fake, { shop_id: 1, shop_domain: fake, customer: { id: 424242, email: "a@b.c" }, orders_requested: [] }, {}],
    ["data request, signed, REVIEWER'S store     ", "/webhooks/compliance", "customers/data_request", reviewer, { shop_id: 2, shop_domain: reviewer, customer: { id: 424242, email: "a@b.c" }, orders_requested: [] }, {}],
    ["customer erasure, signed, fake store       ", "/webhooks/compliance", "customers/redact", fake, { shop_id: 1, shop_domain: fake, customer: { id: 424242, email: "a@b.c" }, orders_to_redact: [] }, {}],
    ["customer erasure, signed, REVIEWER'S store ", "/webhooks/compliance", "customers/redact", reviewer, { shop_id: 2, shop_domain: reviewer, customer: { id: 424242, email: "a@b.c" }, orders_to_redact: [] }, {}],
    ["shop erasure, signed, fake store           ", "/webhooks/compliance", "shop/redact", fake, { shop_id: 1, shop_domain: fake }, {}],
    ["compliance, WRONG signature                ", "/webhooks/compliance", "shop/redact", fake, { shop_id: 1, shop_domain: fake }, { badSignature: true }],
    ["compliance, no Shopify headers at all      ", "/webhooks/compliance", "shop/redact", fake, { shop_id: 1 }, { noHeaders: true }],
  ];
  for (const [label, route, topic, shop, payload, opts] of cases) {
    const r = await send(route, topic, shop, payload, opts);
    console.log(`${label} -> HTTP ${r.status}${r.status >= 500 || r.status === 0 ? "   <== PROBLEM  " + r.body : ""}`);
  }
})();
