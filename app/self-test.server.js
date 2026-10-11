import crypto from "node:crypto";
import { subscribe } from "./live-hub.server.js";

// The auction robot: every 10 minutes the live app tests its own most important paths the way a shopper would, through
// the same signed requests Shopify sends. It uses a pretend store ("selftest"), so no real auction, bidder, email or
// invoice is ever involved, and it deletes everything it created. If a check fails, the health check turns red and the
// owner is emailed once. This catches a bad release within minutes instead of when a real bidder hits it.

export const SELFTEST_SHOP = "selftest.myshopify.com";
export const EVERY_MS = 10 * 60_000;
const slot = () => (globalThis.__HF_SELFTEST__ ||= { at: 0, ok: null, failures: [], checks: 0, ms: 0, running: false });
export const selfTestStatus = () => ({ ...slot() });

// A request signed exactly the way Shopify signs app proxy requests.
export function signedPath(route, extra, secret, nowMs = Date.now()) {
  const p = { shop: SELFTEST_SHOP, path_prefix: "/apps/hellfire-auctions", timestamp: String(Math.floor(nowMs / 1000)), ...extra };
  p.signature = crypto.createHmac("sha256", secret).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("")).digest("hex");
  return `/api/proxy/${route}?${new URLSearchParams(p).toString()}`;
}

export function judge(checks) {
  const failures = checks.filter(([, pass]) => !pass).map(([name, , detail]) => (detail ? `${name} (${detail})` : name));
  return { ok: failures.length === 0, failures, checks: checks.length };
}

export async function runSelfTest({ base, secret, db, subscribeFn = subscribe, fetchImpl = fetch, now = Date.now }) {
  const started = now();
  const checks = [];
  const check = (name, pass, detail = "") => checks.push([name, Boolean(pass), detail]);
  const call = async (method, route, query, body) => {
    const res = await fetchImpl(base + signedPath(route, query, secret, now()), {
      method,
      headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
      body,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  };
  const view = async (gid) => (await call("GET", "auction", { product_id: gid })).json?.auction || null;
  const bid = (gid, who, amount) => call("POST", "auction", { logged_in_customer_id: who }, new URLSearchParams({ product_id: gid, amount: String(amount) }).toString());
  const buy = (gid, who) => call("POST", "auction", { logged_in_customer_id: who }, new URLSearchParams({ product_id: gid, intent: "buy-now" }).toString());

  const stamp = started;
  const gid = (n) => `gid://shopify/Product/${9_000_000_000_000 + (n % 900_000_000)}`;
  const row = (n, extra = {}) =>
    db.auction.create({
      data: { shop: SELFTEST_SHOP, productId: gid(n), title: "Self-test", startingBid: 10, currentBid: 10, startsAt: new Date(stamp - 60_000), endsAt: new Date(stamp + 24 * 3_600_000), status: "LIVE", isTest: true, ...extra },
    });
  let off = () => {};
  try {
    const a = await row(stamp);
    const b = await row(stamp + 1, { buyNowPrice: 40 });
    const events = [];
    off = subscribeFn(a.id, (kind) => events.push(kind));

    const first = await view(a.productId);
    check("the bidding panel's data loads", first && Number(first.bidCount) === 0 && Number(first.currentBid) === 10, first ? `bids ${first.bidCount}, price ${first.currentBid}` : "no data");

    const r1 = await bid(a.productId, "selftest-A", 50);
    check("a first bid is accepted", r1.status === 200 && r1.json?.success === true, `HTTP ${r1.status}`);
    let s = await view(a.productId);
    check("the first bid pays only the starting bid", s && Number(s.bidCount) === 1 && Number(s.currentBid) === 10, s ? `bids ${s.bidCount}, price ${s.currentBid}` : "no data");

    const r2 = await bid(a.productId, "selftest-B", 30);
    check("a lower maximum from someone else is accepted", r2.status === 200 && r2.json?.success === true, `HTTP ${r2.status}`);
    s = await view(a.productId);
    check("proxy bidding keeps the higher bidder in front, just above the runner-up", s && Number(s.bidCount) === 2 && Number(s.currentBid) > 30 && Number(s.currentBid) <= 31, s ? `bids ${s.bidCount}, price ${s.currentBid}` : "no data");
    check("everyone watching is told about each bid, live", events.length >= 2, `${events.length} updates`);

    const offer = await view(b.productId);
    check("a Buy It Now price is offered while there are no bids", offer && Number(offer.buyNowPrice) === 40, offer ? `price ${offer.buyNowPrice}` : "no data");
    const p1 = await buy(b.productId, "selftest-C");
    check("Buy It Now is accepted", p1.status === 200 && p1.json?.success === true, `HTTP ${p1.status}`);
    const bought = await view(b.productId);
    check("Buy It Now ends the auction at that price", bought && Number(bought.bidCount) === 1 && Number(bought.currentBid) === 40 && Date.parse(bought.endsAt) <= now() + 2000, bought ? `bids ${bought.bidCount}, price ${bought.currentBid}` : "no data");
    const p2 = await buy(b.productId, "selftest-D");
    check("a second purchase is refused", p2.status === 409, `HTTP ${p2.status}`);
    const anon = await call("POST", "auction", {}, new URLSearchParams({ product_id: a.productId, amount: "99" }).toString());
    check("bidding while signed out is refused", anon.status === 401, `HTTP ${anon.status}`);

    // ---- Live Drops: first tap wins, the limit, and the refusals ----
    const claim = (saleId, dropId, who) => call("POST", "live-claim", who ? { logged_in_customer_id: who } : {}, new URLSearchParams({ intent: "claim", sale: saleId, drop: dropId }).toString());
    const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const show = await db.actionSale.create({ data: { shop: SELFTEST_SHOP, title: "Self-test show", status: "LIVE", lastActivityAt: new Date(stamp) } });
    const item = (position, extra) =>
      db.actionDrop.create({
        data: { saleId: show.id, shop: SELFTEST_SHOP, position, productId: `gid://shopify/Product/${9_100_000_000_000 + position}`, variantId: `gid://shopify/ProductVariant/${9_100_000_000_000 + position}`, title: `Self-test item ${position}`, price: 5, ...extra },
      });
    const d1 = await item(1, { status: "OPEN", quantity: 3, perPerson: 1 });
    const room = await call("GET", "live", { sale: show.id, format: "json", logged_in_customer_id: "selftest-A" });
    check("Live Drops: the room's data loads", room.status === 200 && room.json?.phase === "open" && room.json?.open?.id === d1.id, `HTTP ${room.status}, ${room.json?.phase}`);
    const tries = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(show.id, d1.id, `selftest-drop-${i}`)));
    const won = tries.filter((x) => x.status === 200 && x.json?.ok === true).length;
    const refused = tries.filter((x) => x.status === 409).length;
    check("Live Drops: 8 people tapping at once on 3 items, exactly 3 get one", won === 3 && refused === 5, `${won} got one, ${refused} refused`);
    const after = await db.actionDrop.findUnique({ where: { id: d1.id } });
    const held = await db.actionClaim.findMany({ where: { dropId: d1.id } });
    check("Live Drops: the count, the claims and the sold-out status agree", after?.claimed === 3 && after?.status === "CLOSED" && held.length === 3 && new Set(held.map((c) => c.customerId)).size === 3, `claimed ${after?.claimed}, ${after?.status}, ${held.length} claims`);
    const d2 = await item(2, { status: "OPEN", quantity: 5, perPerson: 2 });
    const c1 = await claim(show.id, d2.id, "selftest-limit");
    await nap(300);
    const c2 = await claim(show.id, d2.id, "selftest-limit");
    await nap(300);
    const c3 = await claim(show.id, d2.id, "selftest-limit");
    check("Live Drops: a limit of 2 per person stops the third claim", c1.status === 200 && c2.status === 200 && c3.status === 409, `${c1.status}, ${c2.status}, ${c3.status}`);
    const d3 = await item(3, { status: "QUEUED", quantity: 2, perPerson: 1 });
    const early = await claim(show.id, d3.id, "selftest-A");
    check("Live Drops: an item that has not been opened cannot be claimed", early.status === 409, `HTTP ${early.status}`);
    const anonymous = await claim(show.id, d2.id, null);
    check("Live Drops: claiming while signed out is refused", anonymous.status === 401, `HTTP ${anonymous.status}`);
    await db.actionSale.update({ where: { id: show.id }, data: { status: "ENDED" } });
    const late = await claim(show.id, d2.id, "selftest-late");
    check("Live Drops: claiming in a show that has ended is refused", late.status === 409, `HTTP ${late.status}`);
  } catch (error) {
    check("the test ran without an unexpected error", false, String(error?.message || error).slice(0, 160));
  } finally {
    off();
    try {
      const saleIds = (await db.actionSale.findMany({ where: { shop: SELFTEST_SHOP }, select: { id: true } })).map((x) => x.id);
      if (saleIds.length) {
        await db.actionClaim.deleteMany({ where: { saleId: { in: saleIds } } });
        await db.actionBuyer.deleteMany({ where: { saleId: { in: saleIds } } });
        await db.actionDrop.deleteMany({ where: { saleId: { in: saleIds } } });
        await db.actionSale.deleteMany({ where: { id: { in: saleIds } } });
      }
      const ids = (await db.auction.findMany({ where: { shop: SELFTEST_SHOP }, select: { id: true } })).map((x) => x.id);
      if (ids.length) {
        await db.bidEvent.deleteMany({ where: { auctionId: { in: ids } } });
        await db.bid.deleteMany({ where: { auctionId: { in: ids } } });
        await db.auction.deleteMany({ where: { id: { in: ids } } });
      }
    } catch (error) {
      check("the test cleaned up after itself", false, String(error?.message || error).slice(0, 160));
    }
  }
  return { ...judge(checks), ms: now() - started };
}

// One run shortly after every start-up, so a bad release is caught within minutes of going live. Later runs happen on
// the worker's own passes (never on a timer of its own), so the robot never keeps the database awake by itself.
export function selfTestAfterBoot(alertOwner, delayMs = 100_000) {
  if (globalThis.__HF_SELFTEST_BOOT__) return;
  globalThis.__HF_SELFTEST_BOOT__ = true;
  const timer = setTimeout(() => selfTestIfDue(alertOwner).catch((error) => console.error("[hellfire-auctions] self-test error:", error?.message || error)), delayMs);
  if (timer.unref) timer.unref();
}

// Called by the background worker on every pass; does the real work at most once every 10 minutes.
export async function selfTestIfDue(alertOwner) {
  const state = slot();
  const secret = process.env.SHOPIFY_API_SECRET;
  if (process.env.HELLFIRE_SELFTEST === "off" || !secret || state.running) return;
  if (process.uptime() < 90 || Date.now() - state.at < EVERY_MS) return;
  state.running = true;
  try {
    const { default: prisma } = await import("./db.server.js");
    const base = process.env.HELLFIRE_SELFTEST_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
    const wasOk = state.ok;
    const result = await runSelfTest({ base, secret, db: prisma });
    Object.assign(state, { at: Date.now(), ok: result.ok, failures: result.failures, checks: result.checks, ms: result.ms });
    console.log("[HELLFIRE SELFTEST]", JSON.stringify({ ok: result.ok, checks: result.checks, ms: result.ms, failures: result.failures }));
    if (!result.ok && wasOk !== false && alertOwner) {
      await alertOwner("Hellfire Auctions self-test FAILED", ["The automatic self-test found a problem on the live server:", ...result.failures.map((f) => `- ${f}`), "Bids or purchases may be failing for shoppers. Check the latest release."]);
    }
  } finally {
    state.running = false;
  }
}
