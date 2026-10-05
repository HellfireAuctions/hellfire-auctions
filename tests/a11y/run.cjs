// Accessibility scan (axe-core, WCAG 2 A/AA) of what the app puts on a store's pages.
// Run: node tests/a11y/run.cjs   (needs: npm install --no-save axe-core)
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "extensions", "hellfire-auctions-storefront", "assets");
const FIXTURES = path.join(ROOT, "tests", "cards", "fixtures");
const AXE = require.resolve("axe-core/axe.min.js");
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

const now = Date.now();
const H = 3600_000;
const iso = (ms) => new Date(now + ms).toISOString();

const PAGES = {
  "/cards": "collection-dawn.html",
  "/panel": "product-en.html",
  "/block": "live-block.html",
};
// only what the app adds is judged; the fixtures' own plain markup is not ours
const OURS = [["#hellfire-auction-root"], [".hellfire-card-badge"], [".hellfire-live"], [".hellfire-sticky-bar"]];

const RUNNER = `
<script src="/axe.js"></script>
<script>
  window.addEventListener("load", function () {
    setTimeout(function () {
      axe.run({ include: ${JSON.stringify(OURS)} }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })
        .then(function (r) {
          var out = r.violations.map(function (v) {
            return { id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(function (n) { return { target: n.target.join(" "), html: n.html.slice(0, 160), why: (n.failureSummary || "").split("\\n").slice(0, 3).join(" ").slice(0, 300) }; }) };
          });
          var pre = document.createElement("pre"); pre.id = "axe-out"; pre.textContent = JSON.stringify({ violations: out, passes: r.passes.length, scanned: document.querySelectorAll("#hellfire-auction-root, .hellfire-card-badge, .hellfire-live").length });
          document.body.appendChild(pre);
        })
        .catch(function (e) { var pre = document.createElement("pre"); pre.id = "axe-out"; pre.textContent = JSON.stringify({ error: String(e) }); document.body.appendChild(pre); });
    }, 3000);
  });
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/apps/hellfire-auctions/auction-cards") {
    return json({ now: new Date().toISOString(), currency: "USD", auctions: [
      { handle: "test-1", hasBids: true, amount: 325, bidCount: 21, watchers: 12, bidders: 7, hot: true, myStatus: "WINNING", hasReserve: true, reserveMet: false, startsAt: iso(-5 * 24 * H), endsAt: iso(48 * H), status: "LIVE" },
      { handle: "upcoming-item", hasBids: false, amount: 10, bidCount: 0, startsAt: iso(3 * H), endsAt: iso(5 * 24 * H), status: "UPCOMING" },
    ] });
  }
  if (url.pathname === "/apps/hellfire-auctions/auction") {
    return json({ now: new Date().toISOString(), currency: "USD", loggedInCustomerId: "1", auction: { status: "LIVE", currentBid: 20, startingBid: 10, minimumBid: 21, bidCount: 3, watchers: 12, bidders: 7, highestBidder: "b***r", startsAt: iso(-H), endsAt: iso(5 * H), history: [{ bidder: "b***r", amount: 20, at: iso(-60000), mine: true }, { bidder: "k***2", amount: 18, at: iso(-120000), mine: false }], canWatch: true, watching: false, hasReserve: true, reserveMet: false, myStatus: "OUTBID", myMaximumBid: 25, autoExtend: true, isTest: false } });
  }
  if (url.pathname === "/apps/hellfire-auctions/live-auctions") {
    return json({ now: new Date().toISOString(), currency: "USD", auctions: [
      { id: "a", title: "Rainbow zoanthid frag", image: "", url: "/products/one", currentBid: 20, bidCount: 3, endsAt: iso(2 * H), isTest: false },
      { id: "b", title: "Blue acro frag", image: "", url: "/products/two", currentBid: 35, bidCount: 1, endsAt: iso(30 * H), isTest: false },
    ] });
  }
  if (url.pathname === "/axe.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(fs.readFileSync(AXE)); }
  if (url.pathname.startsWith("/assets/")) {
    const file = path.join(ASSETS, path.basename(url.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": file.endsWith(".css") ? "text/css" : "text/javascript" });
    return res.end(fs.readFileSync(file));
  }
  const page = PAGES[url.pathname];
  if (page) {
    const html = fs.readFileSync(path.join(FIXTURES, page), "utf8").replace("<!--HF-EARLY-->", "").replace("</body>", RUNNER + "</body>");
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }
  res.writeHead(404);
  res.end();
});

function dump(url) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hf-a11y-"));
    const child = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--window-size=1000,900", `--user-data-dir=${profile}`, "--virtual-time-budget=9000", "--dump-dom", url]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

(async () => {
  if (!CHROME) throw new Error("No Chrome/Edge found.");
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  let total = 0;
  for (const name of Object.keys(PAGES)) {
    const html = await dump(base + name);
    const m = /<pre id="axe-out">([\s\S]*?)<\/pre>/.exec(html);
    if (!m) { console.log(`${name}: NO RESULT (the scan did not finish)`); total += 1; continue; }
    const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    if (data.error) { console.log(`${name}: ERROR ${data.error}`); total += 1; continue; }
    console.log(`${name}: ${data.scanned} app elements scanned, ${data.passes} checks passed, ${data.violations.length} problem type(s)`);
    for (const v of data.violations) {
      total += v.nodes.length;
      console.log(`  - [${v.impact}] ${v.id}: ${v.help}`);
      for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target}\n      ${n.why}`);
    }
  }
  console.log(total === 0 ? "ACCESSIBILITY: no problems found" : `ACCESSIBILITY: ${total} problem(s) found`);
  server.close();
  process.exit(total === 0 ? 0 : 1);
})();
