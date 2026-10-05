// Marks every auction EXCEPT the new "LIVE LOAD TEST" one as already known, so the load test targets only that one.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const SHOP = "hellfire-auctions-dev.myshopify.com";
function sign(p) { return crypto.createHmac("sha256", SECRET).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("")).digest("hex"); }
function get(route, extra) {
  const p = { shop: SHOP, path_prefix: "/apps/hellfire-auctions", timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  p.signature = sign(p);
  return new Promise((resolve) => https.get({ host: "hellfire-auctions.onrender.com", path: `/api/proxy/${route}?` + new URLSearchParams(p) }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ s: res.statusCode, b }));
  }).on("error", (e) => resolve({ s: 0, b: String(e) })));
}
(async () => {
  const ids = JSON.parse((await get("auction-products", {})).b).auctionProductIds || [];
  let target = null;
  for (const id of ids) {
    const r = await get("auction", { product_id: "gid://shopify/Product/" + id });
    let a; try { a = JSON.parse(r.b).auction; } catch { continue; }
    if (a && /LIVE LOAD TEST/i.test(a.title) && a.status === "LIVE") { target = { id, a }; break; }
  }
  if (!target) { console.log("NO LIVE 'LIVE LOAD TEST' AUCTION FOUND"); process.exit(2); }
  const known = ids.filter((id) => id !== target.id);
  fs.writeFileSync(path.join(__dirname, ".baseline.json"), JSON.stringify({ at: new Date().toISOString(), ids: known }));
  const left = Math.round((Date.parse(target.a.endsAt) - Date.now()) / 1000);
  console.log(`found "${target.a.title}" (product ${target.id}), ${left}s left, ${target.a.bidCount} bids, live address present: ${Boolean(target.a.live)}; ${known.length} older auctions set aside`);
})();
