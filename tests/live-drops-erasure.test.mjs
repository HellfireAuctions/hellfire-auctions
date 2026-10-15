import assert from "node:assert/strict";
import fs from "node:fs";
import { liveDropsDataFor, eraseCustomerLiveDrops, stopShopLiveDrops, eraseShopLiveDrops, eraseOldLiveDrops, RETENTION_DAYS } from "../app/live-drops-erasure.server.js";
import { roomView } from "../app/action-sale.js";

// A pretend database with TWO stores, so we can prove erasure never touches the wrong one.
function world() {
  const t = (v) => new Date(v);
  const tables = {
    actionSale: [
      { id: "A-live", shop: "a.myshopify.com", status: "LIVE", streamUid: "uidA", endedAt: null, updatedAt: t("2026-10-01") },
      { id: "A-done", shop: "a.myshopify.com", status: "ENDED", streamUid: null, endedAt: t("2026-09-01"), updatedAt: t("2026-09-01") },
      { id: "A-draft", shop: "a.myshopify.com", status: "DRAFT", streamUid: null, endedAt: null, updatedAt: t("2026-10-01") },
      { id: "B-live", shop: "b.myshopify.com", status: "LIVE", streamUid: "uidB", endedAt: null, updatedAt: t("2026-10-01") },
    ],
    actionDrop: [
      { id: "d1", saleId: "A-live", shop: "a.myshopify.com", status: "OPEN", title: "Zoa frag", price: 25 },
      { id: "d2", saleId: "A-done", shop: "a.myshopify.com", status: "CLOSED", title: "Blasto", price: 105 },
      { id: "d3", saleId: "B-live", shop: "b.myshopify.com", status: "OPEN", title: "Other store item", price: 9 },
    ],
    actionClaim: [
      { id: "c1", dropId: "d1", saleId: "A-live", shop: "a.myshopify.com", customerId: "alice", quantity: 2, createdAt: t("2026-10-02") },
      { id: "c2", dropId: "d2", saleId: "A-done", shop: "a.myshopify.com", customerId: "alice", quantity: 1, createdAt: t("2026-09-01") },
      { id: "c3", dropId: "d1", saleId: "A-live", shop: "a.myshopify.com", customerId: "bob", quantity: 1, createdAt: t("2026-10-03") },
      { id: "c4", dropId: "d3", saleId: "B-live", shop: "b.myshopify.com", customerId: "alice", quantity: 1, createdAt: t("2026-10-04") },
    ],
    actionBuyer: [
      { saleId: "A-done", customerId: "alice", shop: "a.myshopify.com", invoiceSentAt: t("2026-09-01"), paidAt: t("2026-09-02"), struckAt: null },
      { saleId: "A-live", customerId: "bob", shop: "a.myshopify.com", invoiceSentAt: t("2026-10-05"), paidAt: null, struckAt: t("2026-10-09") },
      { saleId: "B-live", customerId: "alice", shop: "b.myshopify.com", invoiceSentAt: null, paidAt: null, struckAt: null },
    ],
  };
  const ok = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (k === "OR") return v.some((w) => ok(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ("lt" in v) return row[k] != null && new Date(row[k]).getTime() < new Date(v.lt).getTime();
    }
    return v === null ? row[k] == null : row[k] === v;
  });
  const table = (name, joins = {}) => ({
    findMany: async ({ where, take } = {}) => tables[name].filter((r) => ok(r, where)).slice(0, take || 9999).map((r) => (joins.drop ? { ...r, drop: tables.actionDrop.find((d) => d.id === r.dropId) } : { ...r })),
    deleteMany: async ({ where }) => { const gone = tables[name].filter((r) => ok(r, where)); tables[name] = tables[name].filter((r) => !gone.includes(r)); return { count: gone.length }; },
    updateMany: async ({ where, data }) => { const hit = tables[name].filter((r) => ok(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; },
    update: async ({ where, data }) => Object.assign(tables[name].find((r) => r.id === where.id), data),
  });
  return { tables, db: { actionSale: table("actionSale"), actionDrop: table("actionDrop"), actionClaim: table("actionClaim", { drop: true }), actionBuyer: table("actionBuyer") } };
}

// ---------- "what do you hold about me" ----------
let w = world();
let report = await liveDropsDataFor({ shop: "a.myshopify.com", customerId: "alice", db: w.db });
assert.equal(report.claims, 2, "Alice's two claims in store A (not her claim in store B)");
assert.deepEqual(report.items.map((i) => [i.title, i.quantity, i.price]), [["Zoa frag", 2, 25], ["Blasto", 1, 105]], "what, how many and the price");
assert.deepEqual([report.invoices, report.paid, report.unpaidStrikes], [1, 1, 0]);
report = await liveDropsDataFor({ shop: "a.myshopify.com", customerId: "bob", db: w.db });
assert.deepEqual([report.claims, report.invoices, report.paid, report.unpaidStrikes], [1, 1, 0, 1], "Bob: one claim, invoiced, unpaid, one strike");
report = await liveDropsDataFor({ shop: "a.myshopify.com", customerId: "nobody", db: w.db });
assert.deepEqual(report, { claims: 0, items: [], invoices: 0, paid: 0, unpaidStrikes: 0 }, "someone with no records gets an honest empty report");

// ---------- "erase me" ----------
w = world();
let r = await eraseCustomerLiveDrops({ shop: "a.myshopify.com", customerId: "alice", db: w.db });
assert.deepEqual(r, { claims: 2, buyers: 1 });
assert.deepEqual(w.tables.actionClaim.map((c) => c.id).sort(), ["c3", "c4"], "only Alice's claims in store A are gone: Bob's and Alice's claim in store B stay");
assert.deepEqual(w.tables.actionBuyer.map((b) => `${b.shop}:${b.customerId}`).sort(), ["a.myshopify.com:bob", "b.myshopify.com:alice"]);
assert.equal(w.tables.actionDrop.length, 3, "items and shows are the store's, not hers: they stay");
r = await eraseCustomerLiveDrops({ shop: "a.myshopify.com", customerId: "alice", db: w.db });
assert.deepEqual(r, { claims: 0, buyers: 0 }, "asking twice is harmless");

// ---------- the store uninstalls: stop what is running ----------
w = world();
const released = [];
r = await stopShopLiveDrops({ shop: "a.myshopify.com", db: w.db, release: async ({ saleId }) => { released.push(saleId); } });
assert.deepEqual(r, { stopped: 1, channels: 1 });
assert.equal(w.tables.actionSale.find((s) => s.id === "A-live").status, "CANCELLED", "the live show is stopped (and never invoiced: only ENDED shows are)");
assert.equal(w.tables.actionSale.find((s) => s.id === "A-live").streaming, false);
assert.equal(w.tables.actionDrop.find((d) => d.id === "d1").status, "CLOSED", "its open item is closed");
assert.equal(w.tables.actionSale.find((s) => s.id === "A-done").status, "ENDED", "finished shows are left as they were");
assert.equal(w.tables.actionSale.find((s) => s.id === "A-draft").status, "DRAFT");
assert.equal(w.tables.actionSale.find((s) => s.id === "B-live").status, "LIVE", "another store's show is never touched");
assert.deepEqual(released, ["A-live"], "the video channel is shut down, only this store's");
r = await stopShopLiveDrops({ shop: "a.myshopify.com", db: w.db, release: async () => { throw new Error("video service down"); } });
assert.deepEqual(r, { stopped: 0, channels: 1 }, "a video-service problem never stops the rest");

// ---------- the store's data is erased ----------
w = world();
const gone = [];
r = await eraseShopLiveDrops({ shop: "a.myshopify.com", db: w.db, release: async ({ saleId }) => { gone.push(saleId); } });
assert.equal(r.shows, 3);
assert.deepEqual(w.tables.actionSale.map((s) => s.id), ["B-live"], "every show of store A is gone, store B's stays");
assert.deepEqual(w.tables.actionDrop.map((d) => d.id), ["d3"]);
assert.deepEqual(w.tables.actionClaim.map((c) => c.id), ["c4"]);
assert.deepEqual(w.tables.actionBuyer.map((b) => b.shop), ["b.myshopify.com"]);
assert.deepEqual(gone, ["A-live"], "and any leftover video channel is shut down");
await eraseShopLiveDrops({ shop: "a.myshopify.com", db: w.db, release: async () => { throw new Error("must not run: nothing left"); } });

// ---------- the 24 month rule ----------
w = world();
const now = Date.parse("2028-10-15T00:00:00Z");
assert.equal(RETENTION_DAYS, 730);
r = await eraseOldLiveDrops({ db: w.db, now });
assert.equal(r, 1, "only the show that ended more than 24 months ago (A-done, September 2026)");
assert.deepEqual(w.tables.actionSale.map((s) => s.id).sort(), ["A-draft", "A-live", "B-live"], "live and draft shows are never swept, however old");
assert.ok(!w.tables.actionClaim.some((c) => c.saleId === "A-done") && !w.tables.actionBuyer.some((b) => b.saleId === "A-done") && !w.tables.actionDrop.some((d) => d.saleId === "A-done"), "with its items, claims and invoice records");
assert.equal(await eraseOldLiveDrops({ db: w.db, now }), 0, "nothing more to do the second time");
assert.equal(await eraseOldLiveDrops({ db: world().db, now: Date.parse("2026-10-15T00:00:00Z") }), 0, "recent shows are kept");

// ---------- a stopped show reads as ended to shoppers ----------
assert.equal(roomView({ sale: { title: "x", status: "CANCELLED" }, drops: [] }).phase, "ended");

// ---------- it is really wired in (so it cannot be forgotten) ----------
const compliance = fs.readFileSync("app/routes/webhooks.compliance.jsx", "utf8");
assert.ok(compliance.includes("liveDropsDataFor({ shop, customerId })"), "a shopper's data request includes Live Drops");
assert.ok(compliance.includes("eraseCustomerLiveDrops({ shop, customerId })"), "a shopper's erasure includes Live Drops");
assert.ok(compliance.includes("eraseShopLiveDrops({ shop })"), "a store's erasure includes Live Drops");
assert.ok(fs.readFileSync("app/routes/webhooks.app.uninstalled.jsx", "utf8").includes("stopShopLiveDrops({ shop })"), "uninstalling stops live shows");
assert.ok(fs.readFileSync("app/auction-worker.server.js", "utf8").includes("eraseOldLiveDrops("), "the 24-month cleanup includes Live Drops");
assert.ok(fs.readFileSync("app/notifications.server.js", "utf8").includes("report.liveDrops"), "the data-request email lists Live Drops records");

console.log("Live Drops data erasure: all checks passed");
