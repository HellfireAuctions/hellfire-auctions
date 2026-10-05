const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const SECRET = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
const SHOP = "hellfire-auctions-dev.myshopify.com";
function sign(p) { return crypto.createHmac("sha256", SECRET).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("")).digest("hex"); }
const p = { shop: SHOP, path_prefix: "/apps/hellfire-auctions", timestamp: String(Math.floor(Date.now() / 1000)) };
p.signature = sign(p);
https.get({ host: "hellfire-auctions.onrender.com", path: "/api/proxy/auction-products?" + new URLSearchParams(p) }, (res) => {
  let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { console.log("HTTP " + res.statusCode + " length " + b.length); console.log(b.slice(0, 1200)); });
});
const bp = path.join(__dirname, ".baseline.json");
if (fs.existsSync(bp)) { const j = JSON.parse(fs.readFileSync(bp, "utf8")); console.log("baseline keys: " + Object.keys(j).join(", ") + "; ids: " + (j.ids ? j.ids.length : "n/a")); }
