import assert from "node:assert/strict";
import fs from "node:fs";

// The pages an installer reads must match what the app really does. These checks fail if a promise is dropped or an old name returns.
const read = (f) => fs.readFileSync(f, "utf8");
const privacy = read("app/routes/privacy.jsx");
const terms = read("app/routes/terms.jsx");
const help = read("app/routes/help.jsx");
const front = read("app/routes/_index/route.jsx");
const pricing = read("app/routes/pricing.jsx");
const live = read("app/routes/app.live.jsx");

// ---- privacy ----
assert.ok(privacy.includes("Effective October 15, 2026"), "privacy has the new date");
assert.ok(!/run timed,\s+timed auctions/.test(privacy), "the repeated word is gone");
for (const needed of ["Live Drops shows, items, claims and invoice records", "Live Drops claims and invoice records", "Auction and Live Drops records", "<strong>Cloudflare</strong>", "camera and microphone", "live shows are stopped", "claim items in a Live Drops show"]) assert.ok(privacy.includes(needed), "privacy says: " + needed);
assert.ok(/not recorded or stored by us/.test(privacy), "and that video is not recorded");

// ---- terms ----
assert.ok(terms.includes("Effective October 15, 2026"));
const numbers = [...terms.matchAll(/<h2 style=\{S\.h2\}>(\d+)\. /g)].map((m) => Number(m[1]));
assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9], "the sections are numbered 1 to 9 in order");
assert.ok(terms.includes("4. Live Drops (beta)") && terms.includes("Cloudflare if you use the optional Go Live video"), "terms cover Live Drops and Cloudflare");

// ---- help ----
assert.ok(help.includes('["Choose your plan"') && help.includes("Add the shortcuts to your menu") && help.includes("Open Add auction"), "the setup steps match today's first run");
assert.ok(help.includes("switch in the app\\u2019s Settings page"), "the Live Auctions button switch is where it really is");
for (const needed of ["Open for claiming", "30 minutes after the show ends", "an ended show can be resumed", "tracks stock", "Resume the show", "Log in to claim", "live shows are stopped"]) assert.ok(help.includes(needed), "help says: " + needed);

// ---- no old names anywhere an installer can read ----
for (const [name, text] of [["privacy", privacy], ["terms", terms], ["help", help], ["front page", front], ["pricing", pricing], ["Live Drops screen", live]]) {
  for (const stale of ["Live Action Sale", "Live Sale Mode", "Live sale", "Choose a product", "Press Go on an item", "15 minutes after"]) assert.ok(!text.includes(stale), name + " no longer says: " + stale);
  assert.ok(!/ebay/i.test(text.replace(/\/\/.*$/gm, "")), name + " has no other company's name");
}
console.log("Installer-facing wording: all checks passed");
