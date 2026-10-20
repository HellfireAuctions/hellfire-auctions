import assert from "node:assert/strict";
import fs from "node:fs";
import { readWebhook, guardWebhook } from "../app/webhook-guard.server.js";

// Capture what gets logged, so we can prove no failure is ever silent.
const logged = [];
const realError = console.error;
console.error = (...args) => logged.push(args.join(" "));

const req = {};
const okAuth = { webhook: async () => ({ shop: "a.myshopify.com", topic: "app/uninstalled", payload: { id: 1 }, session: undefined }) };

// ---------- a good webhook passes straight through ----------
let r = await readWebhook(req, okAuth);
assert.deepEqual([r.shop, r.topic, r.payload.id], ["a.myshopify.com", "app/uninstalled", 1]);
assert.equal(logged.length, 0, "nothing logged for a normal request");

// ---------- Shopify's own answers are never changed ----------
for (const status of [401, 400, 403]) {
  const rejecting = { webhook: async () => { throw new Response("nope", { status }); } };
  await assert.rejects(() => readWebhook(req, rejecting), (e) => e instanceof Response && e.status === status, `a ${status} from Shopify's library stays a ${status}`);
}
assert.equal(logged.length, 0, "and those expected rejections are not logged as errors");

// ---------- an unreadable body (the bug) becomes a clean 400, with the reason logged ----------
const crashing = { webhook: async () => { throw new SyntaxError("Unexpected token h in JSON at position 1"); } };
await assert.rejects(() => readWebhook(req, crashing), (e) => e instanceof Response && e.status === 400, "an ordinary crash while reading is answered 400, not 500");
assert.ok(logged.some((l) => l.includes("[webhook] could not read the request:") && l.includes("Unexpected token")), "and the real reason is logged");
const strange = { webhook: async () => { throw "a string, not an Error"; } };
await assert.rejects(() => readWebhook(req, strange), (e) => e.status === 400, "even a thrown string is handled");
const nothing = { webhook: async () => { throw undefined; } };
await assert.rejects(() => readWebhook(req, nothing), (e) => e.status === 400, "even throwing nothing is handled");

// ---------- real failures are logged, then answered 500 so Shopify retries ----------
logged.length = 0;
assert.equal(await guardWebhook("test", async () => "fine"), "fine", "successful work returns its result");
await assert.rejects(() => guardWebhook("uninstall", async () => { throw new Error("database is down"); }), (e) => e instanceof Response && e.status === 500, "a real failure answers 500 so Shopify retries");
assert.ok(logged.some((l) => l.includes("[webhook] uninstall failed:") && l.includes("database is down")), "and says why: never a silent 500");
await assert.rejects(() => guardWebhook("x", async () => { throw new Response("teapot", { status: 418 }); }), (e) => e.status === 418, "a response thrown by the work is passed through");

console.error = realError;

// ---------- both endpoints really use it ----------
const uninstall = fs.readFileSync("app/routes/webhooks.app.uninstalled.jsx", "utf8");
const compliance = fs.readFileSync("app/routes/webhooks.compliance.jsx", "utf8");
for (const [name, src] of [["uninstall", uninstall], ["compliance", compliance]]) {
  assert.ok(src.includes("await readWebhook(request, authenticate)"), `${name}: reads the webhook through the guard`);
  assert.ok(!src.includes("await authenticate.webhook(request)"), `${name}: never calls the library bare`);
  assert.ok(src.includes("guardWebhook("), `${name}: the work is guarded, so a failure is logged`);
}

console.log("Webhook guard: all checks passed");
