// One-off check of the live server's signature handling (the fast path must accept Shopify-style signatures and refuse forgeries).
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const SHOP = "hellfire-auctions-dev.myshopify.com";
function sign(p) { return crypto.createHmac("sha256", SECRET).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("")).digest("hex"); }
function url(extra, tamper) {
  const p = { shop: SHOP, path_prefix: "/apps/hellfire-auctions", timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  p.signature = sign(p);
  if (tamper === "shop") p.shop = "someone-else.myshopify.com";
  if (tamper === "old") { p.timestamp = String(Math.floor(Date.now() / 1000) - 600); }
  if (tamper === "nosig") delete p.signature;
  return "https://hellfire-auctions.onrender.com/api/proxy/auction-products?" + new URLSearchParams(p);
}
function get(u) { return new Promise((r) => https.get(u, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => r({ s: res.statusCode, b })); }).on("error", (e) => r({ s: 0, b: String(e) }))); }
(async () => {
  const cases = [["valid signature", url({}, null), 200], ["forged store name", url({}, "shop"), 400], ["expired timestamp (10 min old)", url({}, "old"), 400], ["no signature", url({}, "nosig"), 400]];
  let ok = true;
  for (const [name, u, want] of cases) {
    const r = await get(u);
    const pass = r.s === want;
    ok = ok && pass;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}: server answered ${r.s} (wanted ${want})`);
  }
  console.log(ok ? "LIVE SIGNATURE CHECK: all good" : "LIVE SIGNATURE CHECK: PROBLEM");
})();
