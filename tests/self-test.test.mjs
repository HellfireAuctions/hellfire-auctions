import assert from "node:assert/strict";
import { signedPath, judge, runSelfTest, SELFTEST_SHOP } from "../app/self-test.server.js";
import { validSignature } from "../app/proxy-signature.js";

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
  };
  const fetchImpl = async (url, init = {}) => {
    if (bugs.networkDown) throw new Error("connection refused");
    const u = new URL(url, "http://local");
    assert.equal(validSignature(u.search, SECRET), true, "every request must carry a valid signature");
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
  return { rows, db, run: () => runSelfTest({ base: "http://local", secret: SECRET, db, subscribeFn, fetchImpl }) };
}

// a healthy app passes every check and leaves nothing behind
let w = makeWorld();
let r = await w.run();
assert.deepEqual(r.failures, []);
assert.equal(r.ok, true);
assert.equal(r.checks, 11);
assert.equal(w.rows.size, 0, "everything the robot created is deleted");
assert.ok(r.ms >= 0);

// each deliberate bug is caught, by name
const caught = async (bugs, expected) => {
  const world = makeWorld(bugs);
  const result = await world.run();
  assert.equal(result.ok, false, JSON.stringify(bugs));
  assert.ok(result.failures.some((f) => f.includes(expected)), `${JSON.stringify(bugs)} should be reported as "${expected}" but got ${JSON.stringify(result.failures)}`);
  assert.equal(world.rows.size, 0, `${JSON.stringify(bugs)}: still cleans up`);
};
await caught({ bidsFail: true }, "a first bid is accepted");
await caught({ noProxyBidding: true }, "proxy bidding keeps the higher bidder in front");
await caught({ silent: true }, "everyone watching is told about each bid");
await caught({ wrongBuyNowPrice: true }, "Buy It Now ends the auction at that price");
await caught({ buyNowKeepsRunning: true }, "Buy It Now ends the auction at that price");
await caught({ allowAnonymous: true }, "bidding while signed out is refused");
await caught({ networkDown: true }, "the test ran without an unexpected error");

// a failure to clean up is itself reported
w = makeWorld({ cleanupFails: true });
r = await w.run();
assert.equal(r.ok, false);
assert.ok(r.failures.some((f) => f.includes("cleaned up")));

console.log("Auction robot: all checks passed");
