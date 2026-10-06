// Live check of Live Sale Mode's public room on production (no sale needs to exist): the table is there and the room answers properly.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const SHOP = "hellfire-auctions-dev.myshopify.com";
function sign(p) { return crypto.createHmac("sha256", SECRET).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("")).digest("hex"); }
function get(extra) {
  const p = { shop: SHOP, path_prefix: "/apps/hellfire-auctions", timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  p.signature = sign(p);
  return new Promise((resolve) => https.get({ host: "hellfire-auctions.onrender.com", path: "/api/proxy/live?" + new URLSearchParams(p) }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ s: res.statusCode, type: res.headers["content-type"], b }));
  }).on("error", (e) => resolve({ s: 0, b: String(e) })));
}
(async () => {
  let ok = true;
  const check = (name, pass, detail) => { ok = ok && pass; console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`); };
  const a = await get({ sale: "does-not-exist", format: "json" });
  check("an unknown sale answers 404 as data (and the database table exists)", a.s === 404 && /not found/i.test(a.b), `HTTP ${a.s} ${a.b.slice(0, 60)}`);
  const b = await get({ sale: "does-not-exist" });
  check("an unknown sale shows a friendly page", b.s === 404 && /Live sale not found/.test(b.b), `HTTP ${b.s}`);
  const c = await get({});
  check("no sale in the link is handled", c.s === 404, `HTTP ${c.s}`);
  const d = await get({ sale: "x".repeat(5000), format: "json" });
  check("an absurd link doesn't break anything", d.s === 404, `HTTP ${d.s}`);
  console.log(ok ? "LIVE SALE ROOM CHECK: all good" : "LIVE SALE ROOM CHECK: PROBLEM");
})();
