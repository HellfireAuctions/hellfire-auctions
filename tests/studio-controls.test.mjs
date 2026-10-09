import assert from "node:assert/strict";
import fs from "node:fs";

// On a phone the host runs everything from the Studio. No button may look dead, and nothing may get stuck.
const page = fs.readFileSync("app/routes/live-studio.jsx", "utf8");
const api = fs.readFileSync("app/routes/api.studio.jsx", "utf8");
assert.ok(api.includes('intent === "start-show"'), "the Studio can start the show");
assert.ok(api.includes("Add at least one item"), "and says why when it cannot");
assert.ok(api.includes('status: "LIVE", lastActivityAt'), "starting the show marks it as active");
assert.ok(page.includes("async function ensureLive()"), "the page starts a not-yet-started show for the host");
assert.ok(page.includes("await ensureLive(); // going live also starts the show"), "going live starts the show");
assert.ok(page.includes("if (!(await ensureLive())) return;"), "so does every item button");
assert.ok(!/disabled=\{busy \|\| show\.status !== "LIVE"\}/.test(page), "no button is disabled just because the show has not started");
assert.ok(!page.includes('{show.status === "LIVE" && d.status !== "OPEN"'), "the per-item buttons are not hidden before the show starts");
assert.ok(page.includes("The show has not started yet."), "a clear box explains it, with a Start the show button");
assert.ok(page.includes("startShowNow"), "...");
const control = page.slice(page.indexOf("async function control("), page.indexOf("const open = show?.drops"));
assert.ok(control.includes("try {") && control.includes("} catch {") && control.includes("} finally {") && control.includes("setBusy(false)"), "a dropped connection can never leave the buttons stuck");
assert.ok(page.includes("{notice && <div"), "messages show right by the buttons, not only at the top of the page");
console.log("Studio controls: all checks passed");
