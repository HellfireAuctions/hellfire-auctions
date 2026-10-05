// Live check of Buy It Now on the production server, without creating or buying anything real.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const SHOP = "hellfire-auctions-dev.myshopify.com";
const productId = process.argv[2] || "15578094174319"; // an ended test auction with no Buy It Now price
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
  let ok = true;
  const check = (name, pass, detail) => { ok = ok && pass; console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`); };

  const g = await call("GET", url({ product_id: productId }));
  let json = null;
  try { json = JSON.parse(g.b); } catch { /* reported below */ }
  check("the bidding panel's data still loads", g.s === 200 && json && json.auction, `HTTP ${g.s}`);
  check("it now carries the Buy It Now field (empty when the auction has none)", json && json.auction && "buyNowPrice" in json.auction && json.auction.buyNowPrice === null);

  const p = await call("POST", url({ logged_in_customer_id: "lt-probe" }), new URLSearchParams({ product_id: productId, intent: "buy-now" }).toString());
  let pj = null;
  try { pj = JSON.parse(p.b); } catch { /* reported below */ }
  check("buying an auction with no Buy It Now price is refused politely", p.s === 409 && pj && /Buy It Now price|has ended/.test(pj.error || ""), `HTTP ${p.s} ${pj && pj.error}`);

  const anon = await call("POST", url({}), new URLSearchParams({ product_id: productId, intent: "buy-now" }).toString());
  check("buying while signed out is refused", anon.s === 401, `HTTP ${anon.s}`);

  const bid = await call("POST", url({ logged_in_customer_id: "lt-probe" }), new URLSearchParams({ product_id: productId, amount: "999999" }).toString());
  check("normal bidding code still answers", bid.s >= 400 && bid.s < 500, `HTTP ${bid.s}`);
  console.log(ok ? "LIVE BUY IT NOW CHECK: all good" : "LIVE BUY IT NOW CHECK: PROBLEM");
})();
