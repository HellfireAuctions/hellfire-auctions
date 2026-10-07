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

// The real head script, taken straight from the theme block, so the test runs exactly what stores run.
const EARLY_SCRIPT = (() => {
  const liquid = fs.readFileSync(path.join(ROOT, "extensions", "hellfire-auctions-storefront", "blocks", "auction-runtime.liquid"), "utf8");
  const m = /<script id="hellfire-early">[\s\S]*?<\/script>/.exec(liquid);
  if (!m) throw new Error("head script not found in the theme block");
  return m[0];
})();

function mockData() {
  return {
    now: new Date().toISOString(),
    auctions: [
      { handle: "test-1", hasBids: true, amount: 325, bidCount: 21, watchers: 12, bidders: 7, hot: true, myStatus: "WINNING", startsAt: iso(-5 * 24 * H), endsAt: iso(48 * H), status: "LIVE" },
      { handle: "upcoming-item", hasBids: false, amount: 10, bidCount: 0, startsAt: iso(3 * H), endsAt: iso(5 * 24 * H), status: "UPCOMING" },
      { handle: "ended-item", hasBids: true, amount: 40, bidCount: 3, startsAt: iso(-5 * 24 * H), endsAt: iso(-20 * 1000), status: "ENDED" },
      { handle: "gone-item", hasBids: true, amount: 55, bidCount: 4, startsAt: iso(-5 * 24 * H), endsAt: iso(-2 * H), status: "ENDED" },
      { handle: "late-ended", hasBids: true, amount: 12, bidCount: 2, startsAt: iso(-5 * 24 * H), endsAt: iso(-2 * H), status: "ENDED" },
      { handle: "table-gone", hasBids: true, amount: 30, bidCount: 2, startsAt: iso(-5 * 24 * H), endsAt: iso(-3 * H), status: "ENDED" },
      { handle: "table-live", hasBids: true, amount: 45, bidCount: 5, startsAt: iso(-2 * H), endsAt: iso(5 * H), status: "LIVE" },
      { handle: "art-gone", hasBids: true, amount: 25, bidCount: 1, startsAt: iso(-5 * 24 * H), endsAt: iso(-4 * H), status: "ENDED" },
      { handle: "art-live", hasBids: false, amount: 12, bidCount: 0, startsAt: iso(-2 * H), endsAt: iso(7 * H), status: "LIVE" },
    ],
  };
}

const pages = {
  "/collections/dawn": "collection-dawn.html",
  "/collections/horizon": "collection-horizon.html",
  "/collections/gone": "collection-gone.html",
  "/collections/table": "collection-table.html",
  "/collections/article": "collection-article.html",
  "/pages/live-block": "live-block.html",
  "/pages/live-empty": "live-empty.html",
  "/pages/hub": "hub.html",
  "/pages/hub-empty": "hub-empty.html",
  "/pages/hub-hidden": "hub-hidden.html",
  "/pages/hub-design": "hub-design.html",
  "/pages/hub-fr": "hub-fr.html",
  "/pages/hub-left": "hub-left.html",
  "/cart": "hub.html",
  "/collections/fr": "collection-fr.html",
  "/products/hf-fr": "product-fr.html",
  "/collections/de": "collection-de.html",
  "/products/hf-de": "product-de.html",
  "/collections/pt": "collection-pt.html",
  "/products/hf-pt": "product-pt.html",
  "/collections/it": "collection-it.html",
  "/products/hf-it": "product-it.html",
  "/collections/nl": "collection-nl.html",
  "/products/hf-nl": "product-nl.html",
  "/collections/es": "collection-es.html",
  "/products/hf-ended": "product-ended.html",
  "/products/hf-ended-won": "product-ended-won.html",
  "/collections/live-auctions": "live-collection.html",
  "/collections/early": "early-hide.html",
  "/products/ended-one": "early-own.html",
  "/collections/late": "early-late.html",
  "/pages/live-es": "live-es.html",
  "/products/hf-es": "product-es.html",
  "/products/hf-en": "product-en.html",
  "/products/test-1": path.join("products", "test-1.html"),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/apps/hellfire-auctions/auction-cards") {
    if (mode === "error") { res.writeHead(500); return res.end("boom"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(mode === "garbage" ? "{not json" : JSON.stringify(mockData()));
  }
  if (url.pathname === "/apps/hellfire-auctions/auction" && /\/(998|999)$/.test(url.searchParams.get("product_id") || "")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    const won = /\/998$/.test(url.searchParams.get("product_id"));
    return res.end(JSON.stringify({
      now: new Date().toISOString(), currency: "USD", loggedInCustomerId: "1",
      auction: { status: "ENDED", currentBid: 40, startingBid: 10, minimumBid: 41, bidCount: 3, watchers: 0, bidders: 3, highestBidder: "b***r", startsAt: iso(-5 * 24 * H), endsAt: iso(-2 * H), history: [], canWatch: false, watching: false, hasReserve: false, reserveMet: null, myStatus: won ? "WON" : null, myMaximumBid: null },
    }));
  }
  if (url.pathname === "/apps/hellfire-auctions/auction") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      now: new Date().toISOString(), currency: "USD", loggedInCustomerId: "1",
      auction: { status: "LIVE", currentBid: 20, startingBid: 10, minimumBid: 21, bidCount: 3, watchers: 12, bidders: 7, highestBidder: "b***r", startsAt: iso(-H), endsAt: iso(5 * H), history: [{ bidder: "b***r", amount: 20, at: iso(-60000), mine: true }], canWatch: true, watching: false, hasReserve: true, reserveMet: false, myStatus: "WINNING", myMaximumBid: 25 },
    }));
  }
  if (url.pathname === "/apps/hellfire-auctions/live-auctions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const list = url.searchParams.get("empty") ? [] : [
      { id: "a", title: "Ends first", image: "", url: "/products/one", currentBid: 20, bidCount: 3, endsAt: iso(2 * H), isTest: false },
      { id: "b", title: "Ends second", image: "", url: "/products/two", currentBid: 35, bidCount: 1, endsAt: iso(30 * H), isTest: false },
      { id: "c", title: "Ends third", image: "", url: "/products/three", currentBid: 10, bidCount: 0, endsAt: iso(80 * H), isTest: false },
    ];
    return res.end(JSON.stringify({ now: new Date().toISOString(), currency: "USD", auctions: list }));
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
    return res.end(fs.readFileSync(path.join(FIXTURES, page), "utf8").replace("<!--HF-EARLY-->", EARLY_SCRIPT));
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
  check("Dawn: shows current bid $325.00, 21 bids, time left", /Current Bid.*\$325\.00.*21 bids.*left/s.test(segment(dawn, "card-auction")));
  check("Dawn: countdown shows days, hours, minutes and seconds", /\d+d \d+h \d{2}m \d{2}s left/.test(segment(dawn, "card-auction")));
  check("Dawn: upcoming countdown shows minutes and seconds", /Starts in \d+h \d{2}m \d{2}s/.test(segment(dawn, "card-upcoming")));
  check("Dawn: normal product card untouched", !segment(dawn, "card-normal").includes(BADGE));
  check("Dawn: upcoming card says Starts in", /Starts in/.test(segment(dawn, "card-upcoming")));
  check("Dawn: header and footer links untouched", !/<header>[\s\S]*data-hellfire-card-badge[\s\S]*<\/header>/.test(dawn) && !/<footer>[\s\S]*data-hellfire-card-badge/.test(dawn));
  check("Dawn: theme forms and buttons left in place", count(dawn, 'action="/cart/add"') === 2 && count(dawn, 'name="add"') === 2);

  check("Dawn: theme price hidden on the auction card", /<div class="price" data-hellfire-price-hidden/.test(segment(dawn, "card-auction")));
  check("Dawn: theme price NOT hidden on the normal card", !segment(dawn, "card-normal").includes("data-hellfire-price-hidden"));

  check("CSS: top row rule wins over the generic span rule (top row rule wins)", fs.readFileSync(path.join(ASSETS, "auction-cards.css"), "utf8").includes(".hellfire-card-badge > .hellfire-card-badge__top"));

  const horizon = await dumpDom(`${base}/collections/horizon`);
  check("Horizon: one badge on the auction card even with 2 links", count(segment(horizon, "card-auction"), BADGE) === 1);
  check("Horizon: badge placed after <product-price>", /<\/product-price><a data-hellfire-card-badge/.test(horizon));
  check("Horizon: normal card untouched", !segment(horizon, "card-normal").includes(BADGE));
  check("Horizon: carousel ended card shows Auction ended + Winning bid", /Auction ended[\s\S]*Winning Bid/.test(segment(horizon, "slide-ended")));
  check("Horizon: older-theme .money price hidden on ended auction slide", /<span class="money" data-hellfire-price-hidden/.test(horizon));
  check("Horizon: .money price NOT hidden on normal slide", /id="slide-normal">[^]*?<span class="money">\$9\.00/.test(horizon));
  check("Horizon: carousel normal slide untouched", !((horizon.match(/id="slide-normal">([\s\S]*?)<\/div>/) || [])[1] || "x").includes(BADGE) && /id="slide-normal"/.test(horizon));
  check("Horizon: card added later (infinite scroll) gets a badge", /id="late-card"[\s\S]*data-hellfire-card-badge/.test(horizon));

  check("Horizon: <product-price> hidden on the auction card", /<product-price data-hellfire-price-hidden/.test(segment(horizon, "card-auction")));
  check("Horizon: normal card price NOT hidden", !segment(horizon, "card-normal").includes("data-hellfire-price-hidden"));

  const pdp = await dumpDom(`${base}/products/test-1`);
  check("Product page: no badge for the product being viewed", !pdp.slice(pdp.indexOf('id="main-product"'), pdp.indexOf('id="related"')).includes(BADGE) && !segment(pdp, "related-self").includes(BADGE));
  check("Product page: related auction card gets a badge", segment(pdp, "related-ended").includes(BADGE));
  check("Product page: exactly 1 badge total", count(pdp, BADGE) === 1);

  const goneHtml = await dumpDom(`${base}/collections/gone`);
  check("Ended 2 hours ago: the card is hidden", /id="card-gone"[^>]*display:\s*none/.test(goneHtml));
  check("A live auction card on the same page stays visible with its badge", !/id="card-live"[^>]*display:\s*none/.test(goneHtml) && segment(goneHtml, "card-live").includes(BADGE));

  const tableHtml = await dumpDom(`${base}/collections/table`);
  check("Older table-style theme: the ended card is hidden", /id="card-tgone"[^>]*display:\s*none/.test(tableHtml));
  check("Older table-style theme: the live card keeps its badge", tableHtml.slice(tableHtml.indexOf('id="card-tlive"')).slice(0, 3000).includes(BADGE));
  const articleHtml = await dumpDom(`${base}/collections/article`);
  check("Card with many links to one product: the ended card is hidden", /id="card-agone"[^>]*display:\s*none/.test(articleHtml));
  check("Card with many links to one product: the live card keeps its badge", articleHtml.slice(articleHtml.indexOf('id="card-alive"')).slice(0, 3000).includes(BADGE));

  const liveHtml = await dumpDom(`${base}/pages/live-block`);
  check("Live Auctions block shows the three live auctions", count(liveHtml, 'class="hellfire-live__card') === 3);
  check("Live Auctions block lists the soonest-ending first", liveHtml.indexOf("Ends first") > 0 && liveHtml.indexOf("Ends first") < liveHtml.indexOf("Ends second") && liveHtml.indexOf("Ends second") < liveHtml.indexOf("Ends third"));
  check("Live Auctions block shows a countdown and a bid count", liveHtml.includes("hellfire-live__time") && liveHtml.includes("3 bids"));
  check("Live Auctions block never gets duplicate theme-card badges", count(liveHtml, BADGE) === 0);
  const emptyHtml = await dumpDom(`${base}/pages/live-empty`);
  check("Live Auctions block hides itself when nothing is running", /class="hellfire-live"[^>]*display:\s*none/.test(emptyHtml));

  const esCards = await dumpDom(`${base}/collections/es`);
  check("Spanish store: card badge says Puja actual and 21 pujas", esCards.includes("Puja actual") && esCards.includes("21 pujas") && esCards.includes("Quedan"));
  const esLive = await dumpDom(`${base}/pages/live-es`);
  check("Spanish store: Live Auctions block in Spanish", esLive.includes("Puja actual") && esLive.includes("3 pujas"));
  const panelEs = await dumpDom(`${base}/products/hf-es`);
  check("Spanish store: bid panel labels", panelEs.includes("Puja más alta") && panelEs.includes("Puja inicial") && panelEs.includes("Historial de pujas"));
  check("Spanish store: bid button and my status", panelEs.includes("PUJAR") && panelEs.includes("Eres el mejor postor"));
  check("Spanish store: signed-in bidder is not treated as logged out", !panelEs.includes('data-hf-login="1"') && panelEs.includes("Seguir esta subasta"));
  const panelEn = await dumpDom(`${base}/products/hf-en`);
  check("English store: bid panel unchanged", panelEn.includes("Highest Bid") && panelEn.includes("INCREASE BID") && panelEn.includes("Watch this auction") && !panelEn.includes("Puja"));

  const socialDawn = await dumpDom(`${base}/collections/dawn`);
  check("Social proof on the card: 7 bidders and 12 watching", socialDawn.includes("7 bidders") && socialDawn.includes("12 watching"));
  check("Social proof stays off cards with too little to show", !segment(socialDawn, "card-upcoming").includes("watching"));
  check("Spanish card: 7 postores y 12 siguiendo", esCards.includes("7 postores") && esCards.includes("12 siguiendo"));
  check("Bid panel (English): 7 bidders and 12 watching", panelEn.includes("7 bidders") && panelEn.includes("12 watching"));
  check("Bid panel (Spanish): 7 postores y 12 siguiendo", panelEs.includes("7 postores") && panelEs.includes("12 siguiendo"));

  // ----- no flash: ended auctions are hidden before the page paints, even if the server never answers -----
  mode = "error";
  const earlyHtml = await dumpDom(`${base}/collections/early`);
  const ownHtml = await dumpDom(`${base}/products/ended-one`);
  mode = "ok";
  check("No flash: an ended auction's card is hidden by the page's own first rules", /id="probe-ended"[^>]*data-display="none"/.test(earlyHtml));
  check("No flash: a live auction's placeholder price and quick-add are hidden before paint", /id="probe-live-price"[^>]*data-display="none"/.test(earlyHtml) && /id="probe-live-add"[^>]*data-display="none"/.test(earlyHtml));
  check("No flash: the live auction's card itself stays visible", !/id="probe-live"[^>]*data-display="none"/.test(earlyHtml));
  check("No flash: a normal product is never touched", !/id="probe-normal"[^>]*data-display="none"/.test(earlyHtml) && /id="probe-normal-price"[^>]*data-display="block"/.test(earlyHtml));
  check("No flash: a similar handle (coral-2) is not caught by the rule for coral", !/id="probe-similar"[^>]*data-display="none"/.test(earlyHtml));
  check("No flash: a block that mentions several products is never hidden", !/id="probe-blog"[^>]*data-display="none"/.test(earlyHtml));
  check("No flash: an auction's own page is never hidden by its own rule", !/id="probe-self"[^>]*data-display="none"/.test(ownHtml) && ownHtml.includes('id="probe-self"'));
  const lateHtml = await dumpDom(`${base}/collections/late`);
  check("No flash: a card the theme adds late is hidden right away, not 300 ms later", /id="probe-late"[^>]*data-display="none"/.test(lateHtml));

  const leaveHtml = await dumpDom(`${base}/products/hf-ended`);
  const stayHtml = await dumpDom(`${base}/products/hf-ended-won`);
  const keepHtml = await dumpDom(`${base}/products/hf-ended?keep=1`);
  check("Ended auction page: a visitor who never bid is sent to the live auctions", leaveHtml.includes("LIVE-AUCTIONS-PAGE"));
  check("Ended auction page: the winner stays on it", !stayHtml.includes("LIVE-AUCTIONS-PAGE") && stayHtml.includes("hellfire-auction-root"));
  check("Ended auction page: ?keep=1 lets anyone look at it", !keepHtml.includes("LIVE-AUCTIONS-PAGE") && keepHtml.includes("hellfire-auction-root"));

  // ----- every extra language: the badges and the real bid panel are in that language, from the catalog -----
  for (const lang of ["fr","de","pt","it","nl"]) {
    const words = new Map(require("../../i18n/" + lang + ".cjs"));
    const cardsHtml = await dumpDom(`${base}/collections/${lang}`);
    const panelHtml = await dumpDom(`${base}/products/hf-${lang}`);
    check(`${lang}: card badge wording and bid count`, cardsHtml.includes(words.get("Current Bid")) && cardsHtml.includes(words.get("{n} bids").replace("{n}", "21")));
    check(`${lang}: card social proof`, cardsHtml.includes(words.get("{n} bidders").replace("{n}", "7")) && cardsHtml.includes(words.get("{n} watching").replace("{n}", "12")));
    check(`${lang}: bid panel labels and button`, panelHtml.includes(words.get("Highest Bid")) && panelHtml.includes(words.get("INCREASE BID")) && panelHtml.includes(words.get("Bid history")));
    check(`${lang}: bid panel is not mixed with English`, !panelHtml.includes("INCREASE BID") && !panelHtml.includes("Highest Bid"));
  }

  // ----- the Live Auctions button: the first thing a Shopify reviewer looks for -----
  const hubHtml = await dumpDom(`${base}/pages/hub`);
  check("Hub button: appears on a store page as soon as the embed is on", hubHtml.includes('id="hf-hub-root"') && hubHtml.includes("hf-hub__pill"));
  check("Hub button: says Live Auctions and shows how many are running", hubHtml.includes(">Live Auctions<") && /hf-hub__count"[^>]*>3</.test(hubHtml));
  check("Hub button: lists the running auctions with their prices", hubHtml.includes("Ends first") && hubHtml.includes("$20.00") && hubHtml.includes("Ends third"));
  check("Hub button: the list starts closed and is announced as closed", /id="hf-hub-panel"[^>]*hidden/.test(hubHtml) && hubHtml.includes('aria-expanded="false"'));
  check("Hub button: has a way to see all auctions and is labelled for screen readers", hubHtml.includes('href="/collections/live-auctions"') && hubHtml.includes('role="dialog"') && hubHtml.includes('aria-controls="hf-hub-panel"'));
  const hubEmpty = await dumpDom(`${base}/pages/hub-empty`);
  check("Hub button: with no auctions it still shows, and says so kindly", hubEmpty.includes("hf-hub__pill") && hubEmpty.includes("No live auctions right now.") && !/hf-hub__count"[^>]*>\d/.test(hubEmpty));
  check("Hub button: not hidden when there is nothing running (unless asked)", !/id="hf-hub-root"[^>]*hidden/.test(hubEmpty));
  const hubHidden = await dumpDom(`${base}/pages/hub-hidden`);
  check("Hub button: can be set to hide itself when nothing is running", /id="hf-hub-root"[^>]*hidden/.test(hubHidden));
  const hubDesign = await dumpDom(`${base}/pages/hub-design`);
  check("Hub button: always visible in the theme editor, with a note", !/id="hf-hub-root"[^>]*hidden/.test(hubDesign) && hubDesign.includes("Preview in the theme editor"));
  check("Hub button: text stays readable on a light button colour", hubDesign.includes("#111111"));
  const hubFr = await dumpDom(`${base}/pages/hub-fr`);
  check("Hub button: in French for French shoppers", hubFr.includes("Enchères en cours") && hubFr.includes("Voir toutes les enchères") && hubFr.includes('aria-label="Fermer"'));
  const hubLeft = await dumpDom(`${base}/pages/hub-left`);
  check("Hub button: position, custom text and colour follow the settings", hubLeft.includes("hf-hub--left") && hubLeft.includes(">Auctions<") && hubLeft.includes("#ff5500") && hubLeft.includes("80px"));
  const hubCart = await dumpDom(`${base}/cart`);
  check("Hub button: never covers the cart page", !hubCart.includes("hf-hub-root"));

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
