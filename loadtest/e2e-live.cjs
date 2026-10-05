// End-to-end test of the real-time engine on production: two "browser windows" watch one live TEST auction, a bid is
// placed, and we measure how fast both are told. It refuses to touch anything that isn't a test auction.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const SHOP = "hellfire-auctions-dev.myshopify.com";
const HOST = "hellfire-auctions.onrender.com";

function sign(p) { return crypto.createHmac("sha256", SECRET).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("")).digest("hex"); }
function proxyPath(route, extra) {
  const p = { shop: SHOP, path_prefix: "/apps/hellfire-auctions", timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  p.signature = sign(p);
  return `/api/proxy/${route}?` + new URLSearchParams(p);
}
function call(method, pathAndQuery, body) {
  return new Promise((resolve) => {
    const req = https.request({ method, host: HOST, path: pathAndQuery, headers: body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {} }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ s: res.statusCode, b }));
    });
    req.on("error", (e) => resolve({ s: 0, b: String(e) }));
    if (body) req.write(body);
    req.end();
  });
}
function listen(streamUrl, label, sink) {
  const u = new URL(streamUrl);
  const req = https.get({ host: u.host, path: u.pathname + u.search, headers: { Accept: "text/event-stream" } }, (res) => {
    sink.status = res.statusCode;
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /event: (\w+)/.exec(block);
        if (m) sink.events.push({ name: m[1], at: Date.now() });
      }
    });
  });
  req.on("error", () => {});
  sink.close = () => req.destroy();
  sink.label = label;
}

(async () => {
  // 1. find a live test auction
  const list = await call("GET", proxyPath("auction-products", {}));
  let ids = [];
  try { ids = JSON.parse(list.b).auctionProductIds || []; } catch { /* reported below */ }
  console.log(`products the store reports with auctions: ${ids.length}`);
  let target = null;
  for (const id of ids) {
    const r = await call("GET", proxyPath("auction", { product_id: "gid://shopify/Product/" + id }));
    let j; try { j = JSON.parse(r.b); } catch { continue; }
    const a = j && j.auction;
    if (a && a.status === "LIVE" && a.isTest && a.live) { target = { id, auction: a }; break; }
  }
  if (!target) {
    console.log("NO LIVE TEST AUCTION FOUND. Create a 10-minute test auction (starting bid 1) and run this again.");
    process.exit(2);
  }
  const a = target.auction;
  console.log(`using the test auction "${a.title}" (product ${target.id}), current bid ${a.currentBid}, ${a.bidCount} bids`);

  // 2. two windows connect
  const w1 = { events: [] }, w2 = { events: [] };
  listen(a.live, "window 1", w1);
  listen(a.live, "window 2", w2);
  await new Promise((r) => setTimeout(r, 1500));
  const hello = (w) => w.events.some((e) => e.name === "hello");
  console.log(`window 1 connected: ${hello(w1)} (HTTP ${w1.status}); window 2 connected: ${hello(w2)} (HTTP ${w2.status})`);

  // 3. a bid arrives
  const amount = Math.max(Number(a.minimumBid), Number(a.currentBid) + 1) + 0.0;
  const sent = Date.now();
  const bid = await call("POST", proxyPath("auction", { logged_in_customer_id: "lt-e2e-" + (sent % 100000) }), new URLSearchParams({ product_id: "gid://shopify/Product/" + target.id, amount: String(amount) }).toString());
  const answered = Date.now();
  console.log(`bid of ${amount} answered HTTP ${bid.s} after ${answered - sent} ms`);
  await new Promise((r) => setTimeout(r, 2500));
  const upd = (w) => w.events.find((e) => e.name === "update" && e.at >= sent);
  const u1 = upd(w1), u2 = upd(w2);
  console.log(u1 ? `window 1 was told ${u1.at - sent} ms after the bid was sent` : "window 1 was NOT told");
  console.log(u2 ? `window 2 was told ${u2.at - sent} ms after the bid was sent` : "window 2 was NOT told");

  // 4. what a window sees when it fetches straight away
  const after = JSON.parse((await call("GET", proxyPath("auction", { product_id: "gid://shopify/Product/" + target.id }))).b).auction;
  console.log(`fetching right after: current bid ${after.currentBid} (was ${a.currentBid}), bids ${after.bidCount} (was ${a.bidCount})`);

  w1.close(); w2.close();
  const pass = bid.s === 200 && u1 && u2 && after.bidCount === a.bidCount + 1;
  console.log(pass ? "END-TO-END REAL-TIME TEST: all good" : "END-TO-END REAL-TIME TEST: PROBLEM");
  process.exit(pass ? 0 : 1);
})();
