import assert from "node:assert/strict";
import { goLiveShops, goLiveEnabled, streamIsLive, streamExpired, MAX_STREAM_MS, BEAT_WINDOW_MS } from "../app/go-live.js";
import { signStudioToken, verifyStudioToken, STUDIO_TTL_MS } from "../app/studio-token.server.js";
import { parseLiveInput, createLiveInput, deleteLiveInput, streamConfigured } from "../app/cloudflare-stream.server.js";

// ---------- who has Go Live (the add-on switch for now) ----------
assert.deepEqual([...goLiveShops(" A.myshopify.com , b.myshopify.com,, ")], ["a.myshopify.com", "b.myshopify.com"], "tidy list");
assert.equal(goLiveEnabled("a.myshopify.com", "a.myshopify.com,b.myshopify.com"), true);
assert.equal(goLiveEnabled("A.MyShopify.com ", "a.myshopify.com"), true, "capitals and spaces don't matter");
assert.equal(goLiveEnabled("c.myshopify.com", "a.myshopify.com,b.myshopify.com"), false, "everyone else is off by default");
assert.equal(goLiveEnabled("a.myshopify.com", ""), false);
assert.equal(goLiveEnabled("a.myshopify.com", undefined), false, "no setting: nobody");
assert.equal(goLiveEnabled("", "a.myshopify.com"), false);
assert.equal(goLiveEnabled("a.myshopify.com.evil.com", "a.myshopify.com"), false, "only an exact match counts");

// ---------- is the video really coming through ----------
const now = Date.parse("2026-10-09T12:00:00Z");
const ago = (ms) => new Date(now - ms).toISOString();
const live = { streaming: true, streamPlayUrl: "https://x/play", streamBeatAt: ago(5_000), streamStartedAt: ago(600_000) };
assert.equal(streamIsLive(live, now), true);
assert.equal(streamIsLive({ ...live, streaming: false }, now), false, "stopped");
assert.equal(streamIsLive({ ...live, streamPlayUrl: null }, now), false, "no channel");
assert.equal(streamIsLive({ ...live, streamBeatAt: ago(BEAT_WINDOW_MS + 1_000) }, now), false, "the host's page went quiet: they have left");
assert.equal(streamIsLive({ ...live, streamBeatAt: ago(BEAT_WINDOW_MS - 1_000) }, now), true, "a short pause is fine");
assert.equal(streamIsLive({ ...live, streamBeatAt: null }, now), false, "never checked in");
assert.equal(streamIsLive({ ...live, streamStartedAt: ago(MAX_STREAM_MS + 1_000) }, now), false, "over four hours");
assert.equal(streamIsLive(null, now), false);
assert.equal(streamIsLive(undefined, now), false);
assert.equal(streamExpired({ streaming: true, streamStartedAt: ago(MAX_STREAM_MS + 1_000) }, now), true);
assert.equal(streamExpired({ streaming: true, streamStartedAt: ago(1_000) }, now), false);
assert.equal(streamExpired({ streaming: false, streamStartedAt: ago(MAX_STREAM_MS + 1_000) }, now), false, "already stopped");
assert.equal(streamExpired(null, now), false);

// ---------- the Studio's signed link ----------
const secret = "app-secret-for-tests";
const token = signStudioToken({ shop: "a.myshopify.com", saleId: "sale1", secret, now });
let v = verifyStudioToken(token, secret, now + 1_000);
assert.deepEqual([v.ok, v.shop, v.saleId], [true, "a.myshopify.com", "sale1"], "a good link says which store and show");
assert.equal(v.expires, now + STUDIO_TTL_MS, "good for four hours");
assert.equal(verifyStudioToken(token, secret, now + STUDIO_TTL_MS - 1).ok, true, "until the last moment");
assert.equal(verifyStudioToken(token, secret, now + STUDIO_TTL_MS + 1).ok, false, "then it stops working");
assert.equal(verifyStudioToken(token, "another-secret", now).ok, false, "a link from another server is refused");
const [payload, sig] = token.split(".");
const forged = Buffer.from(JSON.stringify({ s: "other.myshopify.com", i: "sale1", e: now + 99_999_999 })).toString("base64url");
assert.equal(verifyStudioToken(`${forged}.${sig}`, secret, now).ok, false, "changing the store or the time breaks the signature");
assert.equal(verifyStudioToken(`${payload}.${sig.slice(0, -2)}xx`, secret, now).ok, false, "a damaged signature");
for (const bad of ["", null, undefined, "abc", "a.b.c", ".", "x.", ".y", "!!!.???"]) assert.equal(verifyStudioToken(bad, secret, now).ok, false, String(bad));
assert.equal(verifyStudioToken(token, "", now).ok, false, "no secret on the server: never accept anything");
const other = signStudioToken({ shop: "a.myshopify.com", saleId: "sale2", secret, now });
assert.equal(verifyStudioToken(other, secret, now).saleId, "sale2", "each show has its own link");
assert.notEqual(other, token);

// ---------- Cloudflare ----------
const GOOD = { success: true, result: { uid: "abc123", webRTC: { url: "https://customer-x.cloudflarestream.com/abc123/webRTC/publish" }, webRTCPlayback: { url: "https://customer-x.cloudflarestream.com/abc123/webRTC/play" } } };
assert.deepEqual(parseLiveInput(GOOD), { uid: "abc123", publishUrl: GOOD.result.webRTC.url, playUrl: GOOD.result.webRTCPlayback.url });
for (const bad of [null, {}, { result: {} }, { result: { uid: "x" } }, { result: { uid: "x", webRTC: { url: "u" } } }, { result: { webRTC: { url: "u" }, webRTCPlayback: { url: "p" } } }]) assert.equal(parseLiveInput(bad), null, JSON.stringify(bad));

const TOKEN = "cfut_SECRET_TOKEN_VALUE";
const env = { CLOUDFLARE_ACCOUNT_ID: "acct1", CLOUDFLARE_STREAM_TOKEN: TOKEN };
assert.equal(streamConfigured(env), true);
assert.equal(streamConfigured({}), false);
assert.equal(streamConfigured({ CLOUDFLARE_ACCOUNT_ID: "a" }), false);
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
let seen;
const fetchOk = async (url, init) => { seen = { url, init }; return reply(200, GOOD); };
const made = await createLiveInput({ name: "Friday show", fetchImpl: fetchOk, env });
assert.equal(made.uid, "abc123");
assert.equal(seen.url, "https://api.cloudflare.com/client/v4/accounts/acct1/stream/live_inputs", "the right account");
assert.equal(seen.init.method, "POST");
assert.equal(seen.init.headers.Authorization, `Bearer ${TOKEN}`, "the token is sent only to Cloudflare, in the header");
assert.deepEqual(JSON.parse(seen.init.body), { meta: { name: "Friday show" } });
await assert.rejects(() => createLiveInput({ name: "x", fetchImpl: async () => reply(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }), env }), (e) => /Authentication error/.test(e.message) && !e.message.includes(TOKEN), "an error says what Cloudflare said, and never contains the token");
await assert.rejects(() => createLiveInput({ name: "x", fetchImpl: async () => reply(200, { success: true, result: {} }), env }), /did not return the video addresses/);
await assert.rejects(() => createLiveInput({ name: "x", fetchImpl: async () => reply(500, null), env }), /HTTP 500/);
await assert.rejects(() => createLiveInput({ name: "x", fetchImpl: fetchOk, env: {} }), /not set up/, "no settings: a clear message, no request sent");
await assert.rejects(() => createLiveInput({ name: "x", fetchImpl: async () => { throw new Error("network down"); }, env }), /network down/);
assert.equal(JSON.parse(seen.init.body).meta.name, "Friday show");
await createLiveInput({ name: "n".repeat(300), fetchImpl: fetchOk, env });
assert.equal(JSON.parse(seen.init.body).meta.name.length, 100, "names are kept short");

// removing a channel never throws (a leftover channel is harmless), and does nothing without an id
let deleted;
await deleteLiveInput("abc/123", { fetchImpl: async (url, init) => { deleted = { url, init }; return reply(200, { success: true }); }, env });
assert.equal(deleted.url, "https://api.cloudflare.com/client/v4/accounts/acct1/stream/live_inputs/abc%2F123", "the id is made safe");
assert.equal(deleted.init.method, "DELETE");
await deleteLiveInput("abc", { fetchImpl: async () => reply(404, { success: false, errors: [{ code: 1, message: "not found" }] }), env });
await deleteLiveInput("", { fetchImpl: async () => { throw new Error("must not be called"); }, env });
await deleteLiveInput(null, { fetchImpl: async () => { throw new Error("must not be called"); }, env });

console.log("Go Live: all checks passed");
