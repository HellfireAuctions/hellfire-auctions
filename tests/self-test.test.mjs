import assert from "node:assert/strict";
import { signedPath, judge, runSelfTest, SELFTEST_SHOP } from "../app/self-test.server.js";
import { validSignature } from "../app/proxy-signature.js";
import { claimDecision } from "../app/action-sale.js";

const SECRET = "robot-secret";

// ---------- the requests carry a genuine signature ----------
const path = signedPath("auction", { product_id: "gid://shopify/Product/9000000000001", logged_in_customer_id: "selftest-A" }, SECRET, 1_800_000_000_000);
assert.ok(path.startsWith("/api/proxy/auction?"));
const query = "?" + path.split("?")[1];
assert.equal(validSignature(query, SECRET, 1_800_000_000), true, "the real server's own check accepts it");
assert.equal(validSignature(query, "another-secret", 1_800_000_000), false);
assert.equal(validSignature(query.replace("selftest-A", "selftest-B"), SECRET, 1_800_000_000), false, "tampering is detected");
assert.equal(validSignature(query, SECRET, 1_800_000_000 + 600), false, "it expires like any signed request");
assert.equal(new URLSearchParams(path.split("?")[1]).get("shop"), SELFTEST_SHOP, "always the pretend store, never a real one");

// ---------- turning checks into a verdict ----------
assert.deepEqual(judge([["a", true, ""], ["b", true, "x"]]), { ok: true, failures: [], checks: 2 });
assert.deepEqual(judge([["a", true], ["b", false, "HTTP 500"], ["c", false, ""]]), { ok: false, failures: ["b (HTTP 500)", "c"], checks: 3 });
assert.deepEqual(judge([]), { ok: true, failures: [], checks: 0 });

// ---------- a stand-in server that behaves correctly, or with one deliberate bug ----------
function makeWorld(bugs = {}) {
  const rows = new Map();
  const sales = [];
  const drops = [];
  const claims = [];
  const listeners = new Map();
  let seq = 0;
  const reply = (status, body) => ({ status, json: async () => body });
  const tell = (row) => {
    if (!bugs.silent) listeners.get(row.id)?.("update");
  };
  const db = {
    auction: {
      create: async ({ data }) => {
        const row = { id: "r" + ++seq, ...data, bidCount: 0, maxes: [] };
        rows.set(row.productId, row);
        return row;
      },
      findMany: async () => [...rows.values()].map((r) => ({ id: r.id })),
      deleteMany: async ({ where }) => {
        if (bugs.cleanupFails) throw new Error("cannot delete");
        for (const r of [...rows.values()]) if (where.id.in.includes(r.id)) rows.delete(r.productId);
      },
    },
    bidEvent: { deleteMany: async () => {} },
    bid: { deleteMany: async () => {} },
    actionSale: {
      create: async ({ data }) => { const s = { id: "s" + ++seq, ...data }; sales.push(s); return s; },
      update: async ({ where, data }) => Object.assign(sales.find((s) => s.id === where.id), data),
      findMany: async () => sales.map((s) => ({ id: s.id })),
      deleteMany: async ({ where }) => { for (const s of [...sales]) if (where.id.in.includes(s.id)) sales.splice(sales.indexOf(s), 1); },
    },
    actionDrop: {
      create: async ({ data }) => { const d = { id: "d" + ++seq, claimed: 0, ...data }; drops.push(d); return d; },
      findUnique: async ({ where }) => drops.find((d) => d.id === where.id) || null,
      deleteMany: async ({ where }) => { for (const d of [...drops]) if (where.saleId.in.includes(d.saleId)) drops.splice(drops.indexOf(d), 1); },
    },
    actionClaim: {
      findMany: async ({ where }) => claims.filter((c) => c.dropId === where.dropId),
      deleteMany: async ({ where }) => { for (const c of [...claims]) if (where.saleId.in.includes(c.saleId)) claims.splice(claims.indexOf(c), 1); },
    },
    actionBuyer: { deleteMany: async () => {} },
  };
  const fetchImpl = async (url, init = {}) => {
    if (bugs.networkDown) throw new Error("connection refused");
    const u = new URL(url, "http://local");
    assert.equal(validSignature(u.search, SECRET), true, "every request must carry a valid signature");
    if (u.pathname.endsWith("/live")) {
      const sale = sales.find((s) => s.id === u.searchParams.get("sale"));
      const open = drops.find((d) => d.saleId === sale?.id && d.status === "OPEN");
      return reply(200, { phase: sale?.status === "LIVE" && open ? "open" : "between", open: open ? { id: open.id } : null });
    }
    if (u.pathname.endsWith("/live-claim")) {
      const form = new URLSearchParams(init.body || "");
      const who = u.searchParams.get("logged_in_customer_id");
      if (!who && !bugs.claimAnonymous) return reply(401, { ok: false });
      const sale = sales.find((s) => s.id === form.get("sale"));
      const drop = drops.find((d) => d.id === form.get("drop"));
      if (!sale || !drop) return reply(404, { ok: false });
      if (bugs.oversell) {
        drop.claimed += 1;
        claims.push({ id: "c" + ++seq, dropId: drop.id, saleId: sale.id, customerId: who, quantity: 1 });
        return reply(200, { ok: true });
      }
      const already = claims.filter((c) => c.dropId === drop.id && c.customerId === who).reduce((n, c) => n + c.quantity, 0);
      const decision = claimDecision({ saleStatus: bugs.ignoreEnded ? "LIVE" : sale.status, drop: { ...drop, perPerson: bugs.noLimit ? 999 : drop.perPerson, status: bugs.claimNotOpen ? "OPEN" : drop.status }, already });
      if (!decision.ok) return reply(409, { ok: false, code: decision.code, message: decision.message });
      claims.push({ id: "c" + ++seq, dropId: drop.id, saleId: sale.id, customerId: who, quantity: decision.quantity });
      drop.claimed += decision.quantity;
      if (drop.claimed >= drop.quantity) drop.status = "CLOSED";
      return reply(200, { ok: true });
    }
    const method = init.method || "GET";
    const body = new URLSearchParams(init.body || "");
    const row = rows.get(u.searchParams.get("product_id") || body.get("product_id"));
    if (method === "GET") {
      return reply(200, { auction: row && { currentBid: row.currentBid, bidCount: row.bidCount, buyNowPrice: row.bidCount === 0 ? row.buyNowPrice ?? null : null, endsAt: row.endsAt.toISOString() } });
    }
    const who = u.searchParams.get("logged_in_customer_id");
    if (!who && !bugs.allowAnonymous) return reply(401, { error: "Please sign in." });
    if (!who) return reply(200, { success: true });
    if (body.get("intent") === "buy-now") {
      if (!row || row.bidCount > 0 || !row.buyNowPrice) return reply(409, { error: "Buy It Now is no longer available." });
      row.bidCount = 1;
      row.currentBid = bugs.wrongBuyNowPrice ? 39 : row.buyNowPrice;
      if (!bugs.buyNowKeepsRunning) row.endsAt = new Date(Date.now() - 1000);
      tell(row);
      return reply(200, { success: true });
    }
    if (bugs.bidsFail) return reply(500, { error: "boom" });
    row.maxes.push(Number(body.get("amount")));
    row.bidCount += 1;
    const sorted = [...row.maxes].sort((a, b) => b - a);
    row.currentBid = bugs.noProxyBidding || sorted.length === 1 ? row.startingBid : Math.min(sorted[0], sorted[1] + 0.5);
    tell(row);
    return reply(200, { success: true });
  };
  const subscribeFn = (id, fn) => {
    listeners.set(id, fn);
    return () => listeners.delete(id);
  };
  return { rows, sales, drops, claims, db, run: () => runSelfTest({ base: "http://local", secret: SECRET, db, subscribeFn, fetchImpl }) };
}

// a healthy app passes every check and leaves nothing behind
let w = makeWorld();
let r = await w.run();
assert.deepEqual(r.failures, []);
assert.equal(r.ok, true);
assert.equal(r.checks, 18);
assert.equal(w.rows.size, 0, "everything the robot created is deleted");
assert.equal(w.sales.length + w.drops.length + w.claims.length, 0, "including the pretend Live Drops show, items and claims");
assert.ok(r.ms >= 0);

// each deliberate bug is caught, by name
const caught = async (bugs, expected) => {
  const world = makeWorld(bugs);
  const result = await world.run();
  assert.equal(result.ok, false, JSON.stringify(bugs));
  assert.ok(result.failures.some((f) => f.includes(expected)), `${JSON.stringify(bugs)} should be reported as "${expected}" but got ${JSON.stringify(result.failures)}`);
  assert.equal(world.rows.size, 0, `${JSON.stringify(bugs)}: still cleans up`);
  assert.equal(world.sales.length + world.drops.length + world.claims.length, 0, `${JSON.stringify(bugs)}: still cleans up the Live Drops data`);
};
await caught({ bidsFail: true }, "a first bid is accepted");
await caught({ noProxyBidding: true }, "proxy bidding keeps the higher bidder in front");
await caught({ silent: true }, "everyone watching is told about each bid");
await caught({ wrongBuyNowPrice: true }, "Buy It Now ends the auction at that price");
await caught({ buyNowKeepsRunning: true }, "Buy It Now ends the auction at that price");
await caught({ allowAnonymous: true }, "bidding while signed out is refused");
await caught({ networkDown: true }, "the test ran without an unexpected error");
// Live Drops: each way the lock or the rules could break is caught, by name
await caught({ oversell: true }, "8 people tapping at once on 3 items, exactly 3 get one");
await caught({ oversell: true }, "the count, the claims and the sold-out status agree");
await caught({ noLimit: true }, "a limit of 2 per person stops the third claim");
await caught({ claimNotOpen: true }, "an item that has not been opened cannot be claimed");
await caught({ claimAnonymous: true }, "claiming while signed out is refused");
await caught({ ignoreEnded: true }, "claiming in a show that has ended is refused");

// a failure to clean up is itself reported
w = makeWorld({ cleanupFails: true });
r = await w.run();
assert.equal(r.ok, false);
assert.ok(r.failures.some((f) => f.includes("cleaned up")));

console.log("Auction robot: all checks passed");
