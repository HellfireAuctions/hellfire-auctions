import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { readWebhook, guardWebhook } from "../app/webhook-guard.server.js";

process.env.SHOPIFY_API_SECRET = "test-secret";
const logged = [];
const realError = console.error, realWarn = console.warn;
console.error = (...a) => logged.push("E " + a.join(" "));
console.warn = (...a) => logged.push("W " + a.join(" "));

const sign = (body, secret = "test-secret") => crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
const hook = (body, { secret, shop = "gone-store.myshopify.com", topic = "app/uninstalled", noHmac = false, method = "POST" } = {}) => {
  const headers = { "Content-Type": "application/json", "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": shop, "X-Shopify-API-Version": "2026-07" };
  if (!noHmac) headers["X-Shopify-Hmac-Sha256"] = sign(body, secret);
  return new Request("https://hellfire-auctions.onrender.com/webhooks/app/uninstalled", method === "GET" ? { method, headers } : { method, headers, body });
};
const body = JSON.stringify({ shop_id: 1, shop_domain: "gone-store.myshopify.com" });

// ---------- a normal webhook: the library's answer is used as it is ----------
const goodAuth = { webhook: async () => ({ shop: "a.myshopify.com", topic: "APP_UNINSTALLED", payload: { id: 1 }, session: undefined }) };
let r = await readWebhook(hook(body), goodAuth);
assert.deepEqual([r.shop, r.topic], ["a.myshopify.com", "APP_UNINSTALLED"]);
assert.equal(logged.length, 0, "nothing logged for a normal request");

// ---------- Shopify's own plain answers are never changed ----------
for (const status of [401, 400, 405, 403]) {
  const rejecting = { webhook: async () => { throw new Response("nope", { status }); } };
  await assert.rejects(() => readWebhook(hook(body), rejecting), (e) => e instanceof Response && e.status === status, `a ${status} from the library stays a ${status}`);
}
assert.equal(logged.length, 0, "and those rejections are not logged as errors");

// ---------- THE BUG: the library answers 500 (it could not refresh a gone store's token) ----------
const refreshFails = { webhook: async () => { throw new Response(undefined, { status: 500, statusText: "Internal Server Error" }); } };
r = await readWebhook(hook(body), refreshFails);
assert.deepEqual([r.shop, r.topic, r.payload.shop_id], ["gone-store.myshopify.com", "app/uninstalled", 1], "a correctly signed webhook is now processed even though the library failed");
assert.equal(r.session, undefined, "without a session, which these webhooks do not need");
assert.ok(logged.some((l) => l.startsWith("W ") && l.includes("gone-store.myshopify.com") && l.includes("HTTP 500")), "and it says so, with the store and topic");
logged.length = 0;

// privacy topics survive the same failure
r = await readWebhook(hook(JSON.stringify({ shop_id: 9 }), { topic: "shop/redact", shop: "gone2.myshopify.com" }), refreshFails);
assert.deepEqual([r.shop, r.topic, r.payload.shop_id], ["gone2.myshopify.com", "shop/redact", 9]);
logged.length = 0;

// ---------- but the signature is still checked, so nobody can fake it ----------
await assert.rejects(() => readWebhook(hook(body, { secret: "wrong-secret" }), refreshFails), (e) => e instanceof Response && e.status === 401, "a wrong signature is refused (401)");
await assert.rejects(() => readWebhook(hook(body, { noHmac: true }), refreshFails), (e) => e instanceof Response && e.status === 400, "no signature at all is a bad request (400)");
await assert.rejects(() => readWebhook(hook("this is not json {{{"), refreshFails), (e) => e instanceof Response && e.status === 400, "a signed but unreadable body is a bad request (400)");
await assert.rejects(() => readWebhook(hook(body, { method: "GET" }), refreshFails), (e) => e instanceof Response && e.status === 405, "GET is not allowed (405)");

// ---------- any other crash inside the library (a database blip) no longer drops a real webhook ----------
const crashing = { webhook: async () => { throw new Error("Server has closed the connection."); } };
r = await readWebhook(hook(body), crashing);
assert.equal(r.shop, "gone-store.myshopify.com", "a database hiccup in the library no longer loses a genuine, signed webhook");
assert.ok(logged.some((l) => l.includes("Server has closed the connection")), "and the reason is logged");
await assert.rejects(() => readWebhook(hook(body, { secret: "nope" }), crashing), (e) => e.status === 401, "but a forged one is still refused");
const strange = { webhook: async () => { throw "a string, not an Error"; } };
r = await readWebhook(hook(body), strange);
assert.equal(r.topic, "app/uninstalled", "even a thrown string is handled");
logged.length = 0;

// ---------- real failures in the handler's own work are logged, then answered 500 so Shopify retries ----------
assert.equal(await guardWebhook("test", async () => "fine"), "fine");
await assert.rejects(() => guardWebhook("uninstall", async () => { throw new Error("database is down"); }), (e) => e instanceof Response && e.status === 500);
assert.ok(logged.some((l) => l.startsWith("E ") && l.includes("[webhook] uninstall failed:") && l.includes("database is down")), "and says why");
await assert.rejects(() => guardWebhook("x", async () => { throw new Response("teapot", { status: 418 }); }), (e) => e.status === 418);

console.error = realError;
console.warn = realWarn;

// ---------- both endpoints really use it, and uninstall always removes the store's access ----------
const uninstall = fs.readFileSync("app/routes/webhooks.app.uninstalled.jsx", "utf8");
const compliance = fs.readFileSync("app/routes/webhooks.compliance.jsx", "utf8");
for (const [name, src] of [["uninstall", uninstall], ["compliance", compliance]]) {
  assert.ok(src.includes("await readWebhook(request, authenticate)"), `${name}: reads the webhook through the guard`);
  assert.ok(!src.includes("await authenticate.webhook(request)"), `${name}: never calls the library bare`);
  assert.ok(src.includes("guardWebhook("), `${name}: the work is guarded`);
}
assert.ok(!/if \(session\)/.test(uninstall), "uninstall removes the store's access whether or not the library found a session");
assert.ok(uninstall.includes('guardWebhook("uninstall (removing the store\'s access)"'), "and that removal is guarded and logged");

console.log("Webhook guard: all checks passed");
