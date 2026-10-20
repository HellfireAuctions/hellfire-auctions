// Awkward requests, the kind automated review tooling sends. Anything that answers 5xx is a problem; Shopify expects 401 for a bad signature.
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const sign = (body, secret = SECRET) => crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

function post(route, { body = "", topic, shop = "zz-webhook-test.myshopify.com", hmac, contentType = "application/json", extra = {}, method = "POST" } = {}) {
  const headers = { "Content-Length": Buffer.byteLength(body), ...extra };
  if (contentType) headers["Content-Type"] = contentType;
  if (topic) headers["X-Shopify-Topic"] = topic;
  if (shop) headers["X-Shopify-Shop-Domain"] = shop;
  headers["X-Shopify-API-Version"] = "2025-10";
  headers["X-Shopify-Webhook-Id"] = crypto.randomUUID();
  if (hmac !== undefined) headers["X-Shopify-Hmac-Sha256"] = hmac;
  return new Promise((resolve) => {
    const req = https.request({ host: "hellfire-auctions.onrender.com", path: route, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(0));
    if (method !== "GET") req.write(body);
    req.end();
  });
}

(async () => {
  const json = JSON.stringify({ shop_id: 1, shop_domain: "zz-webhook-test.myshopify.com" });
  const notJson = "this is not json {{{";
  const rows = [];
  for (const [name, route, topic] of [["uninstalled", "/webhooks/app/uninstalled", "app/uninstalled"], ["compliance", "/webhooks/compliance", "shop/redact"]]) {
    const t = { topic };
    rows.push([`${name}: wrong signature + empty body        `, await post(route, { ...t, body: "", hmac: sign("", "wrong") })]);
    rows.push([`${name}: wrong signature + not-JSON body     `, await post(route, { ...t, body: notJson, hmac: sign(notJson, "wrong") })]);
    rows.push([`${name}: RIGHT signature + empty body        `, await post(route, { ...t, body: "", hmac: sign("") })]);
    rows.push([`${name}: RIGHT signature + not-JSON body     `, await post(route, { ...t, body: notJson, hmac: sign(notJson) })]);
    rows.push([`${name}: RIGHT signature + JSON, no topic    `, await post(route, { body: json, hmac: sign(json) })]);
    rows.push([`${name}: RIGHT signature + JSON, odd topic   `, await post(route, { topic: "orders/create", body: json, hmac: sign(json) })]);
    rows.push([`${name}: RIGHT signature, no shop header     `, await post(route, { ...t, shop: "", body: json, hmac: sign(json) })]);
    rows.push([`${name}: signature missing entirely          `, await post(route, { ...t, body: json })]);
    rows.push([`${name}: signature is garbage text           `, await post(route, { ...t, body: json, hmac: "%%%not-base64%%%" })]);
    rows.push([`${name}: wrong content type (text/plain)     `, await post(route, { ...t, body: json, hmac: sign(json), contentType: "text/plain" })]);
    rows.push([`${name}: no content type at all              `, await post(route, { ...t, body: json, hmac: sign(json), contentType: null })]);
    rows.push([`${name}: GET instead of POST                 `, await post(route, { method: "GET" })]);
  }
  for (const [label, status] of rows) console.log(`${label} -> HTTP ${status}${status >= 500 || status === 0 ? "   <== PROBLEM" : ""}`);
})();
