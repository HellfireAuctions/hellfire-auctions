// Load test for the live bidding endpoints. Pretend shoppers poll an auction and pretend bidders place bids.
// Requests are signed the way Shopify's app proxy signs them, using the secret from .env (never printed).
//
//   node loadtest/run.cjs baseline     remembers which auction products exist (run BEFORE creating the test auction)
//   node loadtest/run.cjs run          finds the new test auction and runs the staged test (shoppers poll every few seconds)
//   node loadtest/run.cjs run live    the same test, but shoppers use the real-time connection like the real panel does
//
// Safety: it only ever targets the DEV store, uses made-up customer ids ("lt-v-*", "lt-b-*"),
// refuses to run unless the auction has enough time left, and stops itself if errors pile up.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHOP = "hellfire-auctions-dev.myshopify.com"; // never any other store
const BASE = "https://hellfire-auctions.onrender.com";
const BASELINE = path.join(__dirname, ".baseline.json");

function envValue(name) {
  const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = new RegExp("^\\s*" + name + "\\s*=\\s*(.*)$", "m").exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}
// The live app's secret, saved privately by "shopify app env show" (the .env file on this PC is for an older app).
const SECRET_FILE = path.join(__dirname, ".secret");
const SECRET = fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, "utf8").trim() : envValue("SHOPIFY_API_SECRET");
if (!SECRET) throw new Error("No app secret found (loadtest/.secret)");

const agent = new https.Agent({ keepAlive: true, maxSockets: 800 });
const sseAgent = new https.Agent({ keepAlive: true, maxSockets: 2000 }); // one long-lived connection per live shopper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sign(params) {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  return crypto.createHmac("sha256", SECRET).update(message).digest("hex");
}
function signedUrl(pathname, extra) {
  const params = { shop: SHOP, path_prefix: "/apps/hellfire-auctions", timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  params.signature = sign(params);
  return BASE + pathname + "?" + new URLSearchParams(params).toString();
}

function request(method, url, body) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const u = new URL(url);
    const headers = body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {};
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, agent, headers, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: String(e.message || e), body: "" }));
    if (body) req.write(body);
    req.end();
  });
}

const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);
const round = (n) => Math.round(n);

async function productIds() {
  const r = await request("GET", signedUrl("/api/proxy/auction-products", {}));
  if (r.status !== 200) throw new Error(`auction-products answered ${r.status} ${r.error || r.body.slice(0, 120)} (signature or server problem)`);
  return JSON.parse(r.body).auctionProductIds || [];
}

const STAGES = [
  { name: "warm-up", viewers: 20, bidders: 5, seconds: 30 },
  { name: "busy", viewers: 100, bidders: 15, seconds: 45 },
  { name: "very busy", viewers: 300, bidders: 30, seconds: 45 },
  { name: "spike", viewers: 600, bidders: 40, seconds: 30 },
];

async function viewer(i, stopAt, S, ctx) {
  await sleep(Math.random() * 3000);
  const id = i % 2 === 0 ? "lt-v-" + i : null; // half are signed in
  let last = 0;
  let n = 0;
  while (Date.now() < stopAt && !ctx.abort) {
    const r = await request("GET", signedUrl("/api/proxy/auction", { product_id: ctx.productId, ...(id ? { logged_in_customer_id: id } : {}) }));
    S.poll.push(r.ms);
    S.codes[r.status] = (S.codes[r.status] || 0) + 1;
    if (r.status === 200) {
      try {
        const a = JSON.parse(r.body).auction || {};
        const cb = Number(a.currentBid);
        if (Number.isFinite(cb)) {
          if (cb + 0.001 < last) S.regressions += 1; // a price must never go backwards for one viewer
          last = Math.max(last, cb);
        }
        if (Number.isFinite(Number(a.minimumBid))) ctx.minBid = Number(a.minimumBid);
        ctx.latest = a;
      } catch {
        S.badJson += 1;
      }
    }
    if (++n % 3 === 0) {
      const c = await request("GET", signedUrl("/api/proxy/auction-cards", {}));
      S.cards.push(c.ms);
      S.codes[c.status] = (S.codes[c.status] || 0) + 1;
    }
    await sleep(3000 + Math.random() * 1000 - 500);
  }
}

// ---- live mode: shoppers hold the real-time connection and refresh only when told (like the real panel) ----
function openStream(streamUrl, onEvent, S) {
  const u = new URL(streamUrl);
  const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, agent: sseAgent, headers: { Accept: "text/event-stream" } }, (res) => {
    if (res.statusCode !== 200) {
      S.liveRefused += 1;
      res.resume();
      return;
    }
    S.liveOpen += 1;
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /event: (\w+)\ndata: (.*)/.exec(block);
        if (m) {
          let d = null;
          try { d = JSON.parse(m[2]); } catch { /* no details */ }
          onEvent(m[1], d);
        }
      }
    });
  });
  req.on("error", () => { S.liveErrors += 1; });
  return () => req.destroy();
}

async function liveViewer(i, stopAt, S, ctx) {
  await sleep(Math.random() * 3000);
  const id = i % 2 === 0 ? "lt-v-" + i : null; // half are signed in
  let last = 0;
  let lastRefresh = 0;
  let timer = null;
  let closeStream = null;
  let crowd = 1;

  async function refresh() {
    const r = await request("GET", signedUrl("/api/proxy/auction", { product_id: ctx.productId, ...(id ? { logged_in_customer_id: id } : {}) }));
    S.poll.push(r.ms);
    S.codes[r.status] = (S.codes[r.status] || 0) + 1;
    let a = null;
    if (r.status === 200) {
      try {
        a = JSON.parse(r.body).auction || {};
        const cb = Number(a.currentBid);
        if (Number.isFinite(cb)) {
          if (cb + 0.001 < last) S.regressions += 1;
          last = Math.max(last, cb);
        }
        if (Number.isFinite(Number(a.minimumBid))) ctx.minBid = Number(a.minimumBid);
        ctx.latest = a;
      } catch {
        S.badJson += 1;
      }
    }
    return a;
  }
  // the same rule the real panel follows: at most one refresh per 2 seconds, spread out at random
  function schedule() {
    if (timer || Date.now() >= stopAt || ctx.abort) return;
    const spread = Math.min(5000, Math.max(350, crowd * 8)); // the real panel spreads big crowds out
    const wait = Math.max(0, 2000 - (Date.now() - lastRefresh)) + Math.random() * spread;
    timer = setTimeout(async () => {
      timer = null;
      lastRefresh = Date.now();
      if (Date.now() < stopAt && !ctx.abort) await refresh();
    }, wait);
  }

  const first = await refresh();
  if (first && first.live) {
    closeStream = openStream(first.live, (name, d) => {
      if (d && d.n > 0) crowd = d.n;
      if (name === "update") {
        S.events += 1;
        schedule();
      }
    }, S);
  }
  const safety = (async () => {
    while (Date.now() < stopAt && !ctx.abort) {
      await sleep(15000 * (0.9 + Math.random() * 0.2)); // slow safety-net poll while the connection is healthy
      if (Date.now() < stopAt && !ctx.abort) await refresh();
    }
  })();
  const cards = (async () => {
    while (Date.now() < stopAt && !ctx.abort) {
      await sleep(9000 + Math.random() * 1000 - 500); // same cadence as the polling test, so the comparison is fair
      if (Date.now() >= stopAt || ctx.abort) break;
      const c = await request("GET", signedUrl("/api/proxy/auction-cards", {}));
      S.cards.push(c.ms);
      S.codes[c.status] = (S.codes[c.status] || 0) + 1;
    }
  })();
  await Promise.all([safety, cards]);
  if (timer) clearTimeout(timer);
  if (closeStream) closeStream();
}

async function bidder(i, stopAt, S, ctx) {
  const id = "lt-b-" + i;
  await sleep(Math.random() * 2000);
  while (Date.now() < stopAt && !ctx.abort) {
    const amount = Math.round((ctx.minBid + Math.floor(Math.random() * 15)) * 100) / 100;
    const body = new URLSearchParams({ product_id: ctx.productId, amount: String(amount) }).toString();
    const r = await request("POST", signedUrl("/api/proxy/auction", { logged_in_customer_id: id }), body);
    S.bid.push(r.ms);
    S.codes[r.status] = (S.codes[r.status] || 0) + 1;
    let ok = false;
    try { ok = r.status === 200 && JSON.parse(r.body).success === true; } catch { /* counted below */ }
    if (ok) {
      ctx.maxAccepted[id] = Math.max(ctx.maxAccepted[id] || 0, amount);
      ctx.accepted += 1;
      S.accepted += 1;
    } else if (r.status === 400 || r.status === 429) {
      S.refused += 1; // normal: someone outbid them first, or the 1-second cooldown
    }
    await sleep(2500 + Math.random() * 3500);
  }
}

async function runStage(stage, ctx) {
  const S = { poll: [], cards: [], bid: [], codes: {}, regressions: 0, badJson: 0, accepted: 0, refused: 0, events: 0, liveOpen: 0, liveRefused: 0, liveErrors: 0 };
  const stopAt = Date.now() + stage.seconds * 1000;
  const watchdog = setInterval(() => {
    const total = Object.values(S.codes).reduce((a, b) => a + b, 0);
    const bad = Object.entries(S.codes).filter(([c]) => Number(c) === 0 || Number(c) >= 500).reduce((a, [, n]) => a + n, 0);
    if (total > 100 && bad / total > 0.25) {
      ctx.abort = true;
      console.log(`  !! stopping early: ${round((100 * bad) / total)}% of requests failed`);
    }
  }, 2000);
  const tasks = [];
  for (let i = 0; i < stage.viewers; i += 1) tasks.push((ctx.live ? liveViewer : viewer)(i, stopAt, S, ctx));
  for (let i = 0; i < stage.bidders; i += 1) tasks.push(bidder(i, stopAt, S, ctx));
  await Promise.all(tasks);
  clearInterval(watchdog);
  const total = Object.values(S.codes).reduce((a, b) => a + b, 0);
  const failed = Object.entries(S.codes).filter(([c]) => Number(c) === 0 || Number(c) >= 500).reduce((a, [, n]) => a + n, 0);
  return {
    stage: stage.name, viewers: stage.viewers, bidders: stage.bidders, seconds: stage.seconds,
    requests: total, perSecond: round(total / stage.seconds), failed, codes: S.codes,
    pollMs: { p50: round(pct(S.poll, 50)), p95: round(pct(S.poll, 95)), p99: round(pct(S.poll, 99)), max: round(Math.max(0, ...S.poll)) },
    cardsMs: { p50: round(pct(S.cards, 50)), p95: round(pct(S.cards, 95)) },
    bidMs: { p50: round(pct(S.bid, 50)), p95: round(pct(S.bid, 95)), p99: round(pct(S.bid, 99)) },
    bidsAccepted: S.accepted, bidsRefused: S.refused, priceWentBackwards: S.regressions, unreadableAnswers: S.badJson,
    auctionFetches: S.poll.length, auctionPerSecond: round(S.poll.length / stage.seconds),
    live: { opened: S.liveOpen, refused: S.liveRefused, errors: S.liveErrors, events: S.events },
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode === "baseline") {
    const ids = await productIds();
    fs.writeFileSync(BASELINE, JSON.stringify({ at: new Date().toISOString(), ids }));
    console.log(`BASELINE saved: ${ids.length} auction product(s) already exist. The signature check worked (the server accepted my signed request).`);
    return;
  }
  if (mode !== "run") throw new Error("Use: node loadtest/run.cjs baseline | run");

  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8")).ids;
  const now = await productIds();
  const fresh = now.filter((id) => !base.includes(id));
  if (fresh.length !== 1) throw new Error(`Expected exactly 1 new auction since the baseline, found ${fresh.length}. Create just one test auction.`);
  const productId = fresh[0];

  const ctx = { productId, minBid: 1, latest: null, maxAccepted: {}, accepted: 0, abort: false, live: process.argv[3] === "live" };
  console.log(`Mode: ${ctx.live ? "LIVE connection (shoppers refresh only when told)" : "polling (shoppers refresh every few seconds)"}`);
  const first = await request("GET", signedUrl("/api/proxy/auction", { product_id: productId }));
  const a0 = JSON.parse(first.body).auction;
  if (!a0 || a0.status !== "LIVE") throw new Error(`The test auction is not live (status: ${a0 ? a0.status : "missing"}).`);
  const needSec = STAGES.reduce((s, x) => s + x.seconds + 5, 0) + (Number(process.env.LOADTEST_MARGIN) || 90);
  const leftSec = (Date.parse(a0.endsAt) - Date.now()) / 1000;
  if (leftSec < needSec) throw new Error(`Only ${round(leftSec)}s left on the test auction; the test needs ${needSec}s. Create a fresh 10-minute test auction and run again.`);
  ctx.minBid = Number(a0.minimumBid) || 1;
  const startBidCount = Number(a0.bidCount) || 0;
  console.log(`Test auction ${productId}: live, ${round(leftSec)}s left, starting bid ${a0.startingBid}, ${startBidCount} bids so far.`);

  const results = [];
  for (const stage of STAGES) {
    console.log(`\n== ${stage.name}: ${stage.viewers} shoppers watching + ${stage.bidders} bidding for ${stage.seconds}s`);
    const r = await runStage(stage, ctx);
    results.push(r);
    console.log(`  ${r.requests} requests (${r.perSecond}/s), failed: ${r.failed}, codes: ${JSON.stringify(r.codes)}`);
    console.log(`  refresh time  p50 ${r.pollMs.p50} ms  p95 ${r.pollMs.p95} ms  p99 ${r.pollMs.p99} ms  worst ${r.pollMs.max} ms`);
    console.log(`  bid time      p50 ${r.bidMs.p50} ms  p95 ${r.bidMs.p95} ms  p99 ${r.bidMs.p99} ms`);
    console.log(`  auction refreshes ${r.auctionFetches} (${r.auctionPerSecond}/s)`);
    if (ctx.live) console.log(`  live connections ${r.live.opened}/${r.viewers} opened, ${r.live.refused} refused, ${r.live.errors} errors, ${r.live.events} updates received`);
    console.log(`  bids accepted ${r.bidsAccepted}, refused (normal) ${r.bidsRefused}, price went backwards: ${r.priceWentBackwards}`);
    if (ctx.abort) break;
    await sleep(5000);
  }

  // let the server settle, then check how it recovers and whether the bids add up
  await sleep(10000);
  const recover = await request("GET", signedUrl("/api/proxy/auction", { product_id: productId }));
  console.log(`\nRecovery: one refresh 10 seconds after the spike took ${round(recover.ms)} ms (status ${recover.status}).`);

  const final = JSON.parse(recover.body).auction || {};
  const { bidIncrement } = await import("file:///" + path.join(ROOT, "app", "bidding.server.js").replace(/\\/g, "/"));
  const mine = {};
  for (const id of Object.keys(ctx.maxAccepted)) {
    const r = await request("GET", signedUrl("/api/proxy/auction", { product_id: productId, logged_in_customer_id: id }));
    try { mine[id] = JSON.parse(r.body).auction; } catch { mine[id] = null; }
  }
  const checks = [];
  const bidders = Object.keys(ctx.maxAccepted).sort((a, b) => ctx.maxAccepted[b] - ctx.maxAccepted[a]);
  checks.push(["Every bid the server accepted is counted once", Number(final.bidCount) - startBidCount === ctx.accepted, `server counted ${Number(final.bidCount) - startBidCount}, I was told "accepted" ${ctx.accepted} times`]);
  checks.push(["Each bidder's stored maximum matches the highest bid they were told was accepted", bidders.every((id) => Number(mine[id]?.myMaximumBid) === ctx.maxAccepted[id]), bidders.filter((id) => Number(mine[id]?.myMaximumBid) !== ctx.maxAccepted[id]).slice(0, 3).map((id) => `${id}: stored ${mine[id]?.myMaximumBid} vs ${ctx.maxAccepted[id]}`).join("; ") || "all match"]);
  const winners = bidders.filter((id) => mine[id]?.myStatus === "WINNING");
  checks.push(["Exactly one bidder is winning, and it is the one with the highest maximum", winners.length === 1 && winners[0] === bidders[0], `winning: ${winners.join(",") || "none"}; highest maximum: ${bidders[0]}`]);
  if (bidders.length > 1) {
    const max2 = ctx.maxAccepted[bidders[1]];
    const expected = Math.min(ctx.maxAccepted[bidders[0]], Math.round((max2 + bidIncrement(max2)) * 100) / 100);
    checks.push(["The final price is exactly what proxy bidding says it should be", Math.abs(Number(final.currentBid) - expected) < 0.005, `server says ${final.currentBid}, expected ${expected}`]);
  }
  if (ctx.live) checks.push(["Every stage: at least 95% of watchers got their live connection", results.every((r) => r.live.opened >= 0.95 * r.viewers), results.map((r) => `${r.stage} ${r.live.opened}/${r.viewers}`).join(", ")]);
  checks.push(["No shopper ever saw the price go backwards", results.every((r) => r.priceWentBackwards === 0), `${results.reduce((s, r) => s + r.priceWentBackwards, 0)} backwards moves`]);
  checks.push(["No request failed outright (no server errors, no timeouts)", results.every((r) => r.failed === 0), `${results.reduce((s, r) => s + r.failed, 0)} failed`]);

  console.log("\nCORRECTNESS CHECKS");
  let allOk = true;
  for (const [name, ok, detail] of checks) {
    allOk = allOk && ok;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  }
  const out = path.join(__dirname, `results-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ productId, results, checks: checks.map(([n, o, d]) => ({ n, o, d })), final }, null, 2));
  console.log(`\nLOAD TEST ${allOk ? "FINISHED: all checks passed" : "FINISHED: some checks FAILED"}  (details saved in ${path.basename(out)})`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("LOAD TEST STOPPED: " + e.message);
  process.exit(2);
});
