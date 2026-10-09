import assert from "node:assert/strict";
import { startStream, stopStream, beatStream, releaseStream, openNextDrop } from "../app/stream-control.server.js";

// A tiny pretend database for the show table.
function fakeDb(rows, drops = []) {
  const find = (where) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
  return {
    actionSale: {
      findFirst: async ({ where }) => { const r = find(where); return r ? { ...r } : null; },
      update: async ({ where, data }) => { Object.assign(find(where), data); },
      updateMany: async ({ where, data }) => { const matched = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)); matched.forEach((r) => Object.assign(r, data)); return { count: matched.length }; },
    },
    actionDrop: { findMany: async ({ where }) => drops.filter((d) => d.saleId === where.saleId && d.shop === where.shop).sort((a, b) => a.position - b.position) },
  };
}
const show = (over = {}) => ({ id: "s1", shop: "a.myshopify.com", title: "Friday", status: "LIVE", streaming: false, streamUid: null, streamPublishUrl: null, streamPlayUrl: null, streamStartedAt: null, streamBeatAt: null, ...over });

// ---------- starting ----------
let rows = [show()];
let db = fakeDb(rows);
let created = 0;
const create = async ({ name }) => { created += 1; assert.equal(name, "Friday"); return { uid: "u1", publishUrl: "https://p", playUrl: "https://w" }; };
let r = await startStream({ shop: "a.myshopify.com", saleId: "s1", db, create });
assert.deepEqual(r, { ok: true, publishUrl: "https://p" });
assert.equal(created, 1, "the channel is made the first time");
assert.equal(rows[0].streaming, true);
assert.equal(rows[0].streamUid, "u1");
assert.equal(rows[0].streamPlayUrl, "https://w");
assert.ok(rows[0].streamBeatAt instanceof Date && rows[0].streamStartedAt instanceof Date);
const startedAt = rows[0].streamStartedAt;
await new Promise((resolve) => setTimeout(resolve, 5));
r = await startStream({ shop: "a.myshopify.com", saleId: "s1", db, create });
assert.equal(created, 1, "pressing Go live again reuses the same channel");
assert.equal(rows[0].streamStartedAt, startedAt, "the 4-hour clock does not restart while streaming");
assert.equal(r.ok, true);

// stop, then start again: the channel is kept, the clock restarts
await stopStream({ shop: "a.myshopify.com", saleId: "s1", db });
assert.equal(rows[0].streaming, false);
assert.equal(rows[0].streamBeatAt, null);
assert.equal(rows[0].streamUid, "u1", "kept so the host can start again");
r = await startStream({ shop: "a.myshopify.com", saleId: "s1", db, create });
assert.equal(created, 1);
assert.equal(rows[0].streaming, true);

// refusals
assert.equal((await startStream({ shop: "a.myshopify.com", saleId: "nope", db, create })).ok, false, "unknown show");
assert.equal((await startStream({ shop: "other.myshopify.com", saleId: "s1", db, create })).ok, false, "another store's show is never found");
rows = [show({ status: "ENDED" })];
db = fakeDb(rows);
r = await startStream({ shop: "a.myshopify.com", saleId: "s1", db, create });
assert.equal(r.ok, false);
assert.match(r.message, /ended/);
rows = [show()];
db = fakeDb(rows);
await assert.rejects(() => startStream({ shop: "a.myshopify.com", saleId: "s1", db, create: async () => { throw new Error("Cloudflare Stream: 10000 Authentication error"); } }), /Authentication error/, "a video-service problem reaches the caller");
assert.equal(rows[0].streaming, false, "nothing is half-started");

// ---------- check-ins ----------
rows = [show({ streaming: true, streamUid: "u", streamPlayUrl: "w", streamPublishUrl: "p", streamBeatAt: new Date(0) })];
db = fakeDb(rows);
assert.equal((await beatStream({ shop: "a.myshopify.com", saleId: "s1", db })).ok, true);
assert.ok(rows[0].streamBeatAt.getTime() > 0, "the check-in time moves forward");
rows[0].streaming = false;
assert.equal((await beatStream({ shop: "a.myshopify.com", saleId: "s1", db })).ok, false, "a stopped stream cannot be revived by a stray check-in");
assert.equal((await beatStream({ shop: "other.myshopify.com", saleId: "s1", db })).ok, false);

// ---------- shutting the channel down ----------
rows = [show({ streaming: true, streamUid: "u9", streamPublishUrl: "p", streamPlayUrl: "w", streamStartedAt: new Date(), streamBeatAt: new Date() })];
db = fakeDb(rows);
let removed = [];
r = await releaseStream({ shop: "a.myshopify.com", saleId: "s1", db, remove: async (uid) => removed.push(uid) });
assert.deepEqual(removed, ["u9"], "the channel is deleted at the video service");
assert.deepEqual([rows[0].streaming, rows[0].streamUid, rows[0].streamPublishUrl, rows[0].streamPlayUrl, rows[0].streamStartedAt, rows[0].streamBeatAt], [false, null, null, null, null, null], "and forgotten here");
removed = [];
await releaseStream({ shop: "a.myshopify.com", saleId: "s1", db, remove: async (uid) => removed.push(uid) });
assert.deepEqual(removed, [], "a show with no channel has nothing to delete");
assert.equal((await releaseStream({ shop: "a.myshopify.com", saleId: "nope", db, remove: async () => { throw new Error("must not run"); } })).ok, false);
assert.equal((await releaseStream({ shop: "other.myshopify.com", saleId: "s1", db, remove: async () => { throw new Error("must not run"); } })).ok, false, "never another store's");

// ---------- next item ----------
const drop = (id, position, status, claimed = 0, quantity = 5) => ({ id, saleId: "s1", shop: "a.myshopify.com", position, status, claimed, quantity, title: "Item " + id });
const calls = [];
const open = async (args) => { calls.push(["open", args.dropId]); return { ok: true }; };
const close = async () => { calls.push(["close"]); return { ok: true }; };
db = fakeDb([show()], [drop("c", 3, "QUEUED"), drop("a", 1, "CLOSED", 5), drop("b", 2, "OPEN", 2)]);
r = await openNextDrop({ shop: "a.myshopify.com", saleId: "s1", db, open, close });
assert.deepEqual(calls, [["close"], ["open", "c"]], "closes the open item first, then opens the next waiting one");
assert.equal(r.message, "Now selling: Item c");
calls.length = 0;
db = fakeDb([show()], [drop("a", 1, "CLOSED", 5), drop("b", 2, "QUEUED", 5, 5)]);
r = await openNextDrop({ shop: "a.myshopify.com", saleId: "s1", db, open, close });
assert.deepEqual(calls, [["close"]], "a sold-out waiting item is skipped");
assert.match(r.message, /no more items/);
calls.length = 0;
db = fakeDb([show()], [drop("a", 1, "QUEUED", 0, 3), drop("z", 9, "QUEUED")]);
await openNextDrop({ shop: "a.myshopify.com", saleId: "s1", db, open, close });
assert.deepEqual(calls[1], ["open", "a"], "in show order");
r = await openNextDrop({ shop: "a.myshopify.com", saleId: "s1", db, open: async () => ({ ok: false, message: "Start the show first." }), close });
assert.equal(r.ok, false);
assert.equal(r.message, "Start the show first.", "a refusal is passed along");

console.log("Go Live video lifecycle: all checks passed");
