// Browser test for the product-card badges: serves fixture pages that mimic Dawn and Horizon
// markup, runs the real auction-cards.js in headless Chrome, and checks the resulting page.
// Run: node tests/cards/run.cjs
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "extensions", "hellfire-auctions-storefront", "assets");
const FIXTURES = path.join(__dirname, "fixtures");
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

let mode = "ok"; // ok | error | garbage
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const H = 3600_000;

function mockData() {
  return {
    now: new Date().toISOString(),
    auctions: [
      { handle: "test-1", hasBids: true, amount: 325, bidCount: 21, startsAt: iso(-5 * 24 * H), endsAt: iso(48 * H), status: "LIVE" },
      { handle: "upcoming-item", hasBids: false, amount: 10, bidCount: 0, startsAt: iso(3 * H), endsAt: iso(5 * 24 * H), status: "UPCOMING" },
      { handle: "ended-item", hasBids: true, amount: 40, bidCount: 3, startsAt: iso(-5 * 24 * H), endsAt: iso(-1 * H), status: "ENDED" },
    ],
  };
}

const pages = {
  "/collections/dawn": "collection-dawn.html",
  "/collections/horizon": "collection-horizon.html",
  "/products/test-1": path.join("products", "test-1.html"),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/apps/hellfire-auctions/auction-cards") {
    if (mode === "error") { res.writeHead(500); return res.end("boom"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(mode === "garbage" ? "{not json" : JSON.stringify(mockData()));
  }
  if (url.pathname.startsWith("/assets/")) {
    const file = path.join(ASSETS, path.basename(url.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": file.endsWith(".css") ? "text/css" : "text/javascript" });
    return res.end(fs.readFileSync(file));
  }
  const page = pages[url.pathname];
  if (page) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(FIXTURES, page)));
  }
  res.writeHead(404);
  res.end();
});

function dumpDom(url) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hf-cards-"));
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`, "--virtual-time-budget=6000", "--dump-dom", url,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}


function screenshot(url, file) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hf-shot-"));
    const child = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`,
      "--virtual-time-budget=6000", "--window-size=900,700", `--screenshot=${file}`, url]);
    child.on("close", resolve);
  });
}

const count = (html, needle) => html.split(needle).length - 1;
function segment(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return "";
  const end = html.indexOf("</li>", start);
  const endDiv = html.indexOf('<div class="slide"', start + 10);
  const stops = [end, endDiv, html.indexOf("</main>", start)].filter((n) => n > 0);
  return html.slice(start, Math.min(...stops));
}

let failures = 0;
function check(name, condition) {
  console.log(`${condition ? "ok  " : "FAIL"} - ${name}`);
  if (!condition) failures += 1;
}

(async () => {
  if (!CHROME) throw new Error("No Chrome/Edge found for the browser test.");
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const BADGE = "data-hellfire-card-badge";

  mode = "ok";
  const dawn = await dumpDom(`${base}/collections/dawn`);
  check("Dawn: 2 badges (live auction + upcoming), none for normal product", count(dawn, BADGE) === 2);
  check("Dawn: auction card has badge", segment(dawn, "card-auction").includes(BADGE));
  check("Dawn: badge sits right after the theme price", /<\/span><\/div><\/div><a data-hellfire-card-badge/.test(segment(dawn, "card-auction")));
  check("Dawn: shows current bid $325.00, 21 bids, time left", /Current bid.*\$325\.00.*21 bids.*left/s.test(segment(dawn, "card-auction")));
  check("Dawn: normal product card untouched", !segment(dawn, "card-normal").includes(BADGE));
  check("Dawn: upcoming card says Starts in", /Starts in/.test(segment(dawn, "card-upcoming")));
  check("Dawn: header and footer links untouched", !/<header>[\s\S]*data-hellfire-card-badge[\s\S]*<\/header>/.test(dawn) && !/<footer>[\s\S]*data-hellfire-card-badge/.test(dawn));
  check("Dawn: theme forms and buttons left in place", count(dawn, 'action="/cart/add"') === 2 && count(dawn, 'name="add"') === 2);

  check("Dawn: theme price hidden on the auction card", /<div class="price" data-hellfire-price-hidden/.test(segment(dawn, "card-auction")));
  check("Dawn: theme price NOT hidden on the normal card", !segment(dawn, "card-normal").includes("data-hellfire-price-hidden"));

  const horizon = await dumpDom(`${base}/collections/horizon`);
  check("Horizon: one badge on the auction card even with 2 links", count(segment(horizon, "card-auction"), BADGE) === 1);
  check("Horizon: badge placed after <product-price>", /<\/product-price><a data-hellfire-card-badge/.test(horizon));
  check("Horizon: normal card untouched", !segment(horizon, "card-normal").includes(BADGE));
  check("Horizon: carousel ended card shows Auction ended + Winning bid", /Auction ended[\s\S]*Winning bid/.test(segment(horizon, "slide-ended")));
  check("Horizon: carousel normal slide untouched", !((horizon.match(/id="slide-normal">([\s\S]*?)<\/div>/) || [])[1] || "x").includes(BADGE) && /id="slide-normal"/.test(horizon));
  check("Horizon: card added later (infinite scroll) gets a badge", /id="late-card"[\s\S]*data-hellfire-card-badge/.test(horizon));

  check("Horizon: <product-price> hidden on the auction card", /<product-price data-hellfire-price-hidden/.test(segment(horizon, "card-auction")));
  check("Horizon: normal card price NOT hidden", !segment(horizon, "card-normal").includes("data-hellfire-price-hidden"));

  const pdp = await dumpDom(`${base}/products/test-1`);
  check("Product page: no badge for the product being viewed", !pdp.slice(pdp.indexOf('id="main-product"'), pdp.indexOf('id="related"')).includes(BADGE) && !segment(pdp, "related-self").includes(BADGE));
  check("Product page: related auction card gets a badge", segment(pdp, "related-ended").includes(BADGE));
  check("Product page: exactly 1 badge total", count(pdp, BADGE) === 1);

  if (process.env.SHOT_DIR) {
    await screenshot(`${base}/collections/dawn`, path.join(process.env.SHOT_DIR, "cards-dawn.png"));
    await screenshot(`${base}/collections/horizon`, path.join(process.env.SHOT_DIR, "cards-horizon.png"));
  }

  mode = "error";
  const broken = await dumpDom(`${base}/collections/dawn`);
  check("Server error: no badges, page otherwise intact", count(broken, BADGE) === 0 && count(broken, 'name="add"') === 2);

  mode = "garbage";
  const garbage = await dumpDom(`${base}/collections/horizon`);
  check("Bad data: no badges, no crash", count(garbage, BADGE) === 0 && garbage.includes("late-card"));

  server.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll card checks passed");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
