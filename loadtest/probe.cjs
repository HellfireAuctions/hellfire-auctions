// Places ONE bid as a made-up customer on the newest test auction, to prove bidding works before a full run.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const SHOP = "hellfire-auctions-dev.myshopify.com";
const productId = process.argv[2];
if (!productId) throw new Error("usage: node loadtest/probe.cjs <product id>");
function sign(p) { return crypto.createHmac("sha256", SECRET).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("")).digest("hex"); }
function url(extra) {
  const p = { shop: SHOP, path_prefix: "/apps/hellfire-auctions", timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  p.signature = sign(p);
  return new URL("https://hellfire-auctions.onrender.com/api/proxy/auction?" + new URLSearchParams(p));
}
function call(method, u, body) {
  return new Promise((resolve) => {
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {} }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ s: res.statusCode, b }));
    });
    req.on("error", (e) => resolve({ s: 0, b: String(e) }));
    if (body) req.write(body);
    req.end();
  });
}
(async () => {
  const before = JSON.parse((await call("GET", url({ product_id: productId }))).b).auction;
  const amount = Number(before.minimumBid) + 1;
  const r = await call("POST", url({ logged_in_customer_id: "lt-probe" }), new URLSearchParams({ product_id: productId, amount: String(amount) }).toString());
  const after = JSON.parse((await call("GET", url({ product_id: productId }))).b).auction;
  console.log(`BID PROBE: bid of ${amount} answered ${r.s} ${r.b.slice(0, 120)}`);
  console.log(`price now shows ${after.currentBid} (was ${before.currentBid}); bids ${before.bidCount} -> ${after.bidCount}`);
  console.log(r.s === 200 && after.bidCount === before.bidCount + 1 ? "BIDDING WORKS" : "BIDDING STILL BROKEN");
})();
