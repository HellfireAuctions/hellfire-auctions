import assert from "node:assert/strict";
import fs from "node:fs";

// The host must always see what to press next: the controls sit above the tall room card, every item can be opened (which also
// starts the show), and a show that has not started says so with a big Start button.
const app = fs.readFileSync("app/routes/app.live.jsx", "utf8");
const at = (s) => app.indexOf(s);
assert.ok(at("<StartPanel sale={sale} busy={busy} />") > 0 && at("<StartPanel") < at("<RoomCard sale={sale}"), "the Ready to sell box is above the room card");
assert.ok(at("<NowSelling sale={sale} busy={busy} />") > 0 && at("<NowSelling sale={sale}") < at("<RoomCard sale={sale}"), "Now selling is above the room card");
assert.ok(app.includes("function StartPanel(") && app.includes("Ready to sell?") && app.includes('intent="start" label="Start the show" primary'), "with a Start the show button");
assert.ok(/sale\.status !== "ENDED" && d\.status !== "OPEN" && remaining\(d\) > 0 && <Act saleId=\{sale\.id\} intent="go"/.test(app), "every item can be opened, even before the show starts");
assert.ok(!app.includes('{live && d.status !== "OPEN" && remaining(d) > 0 && <Act'), "...never hidden just because the show has not started");
const go = app.slice(at('if (intent === "go") {'), at('if (intent === "close") {'));
assert.ok(go.includes('sale.status === "DRAFT"') && go.includes('status: "LIVE"'), "opening an item starts a show that has not started");
const next = app.slice(at('if (intent === "next") {'), at('if (intent === "start") {'));
assert.ok(next.includes('sale.status === "DRAFT"') && next.includes('status: "LIVE"'), "so does the next item");
assert.ok(app.includes("<details>") && app.includes("Video link and how it works") && app.includes("</details>"), "the room card folds up");
console.log("Host screen flow: all checks passed");
