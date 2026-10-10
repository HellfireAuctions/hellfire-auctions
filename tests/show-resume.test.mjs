import assert from "node:assert/strict";
import fs from "node:fs";

// An ended show must never be a dead end: ending asks first, and any ended show can be resumed (in the app and in the Studio).
const app = fs.readFileSync("app/routes/app.live.jsx", "utf8");
const api = fs.readFileSync("app/routes/api.studio.jsx", "utf8");
const studio = fs.readFileSync("app/routes/live-studio.jsx", "utf8");
assert.ok(app.includes('intent === "resume"'), "the app can resume a show");
assert.ok(/status: "LIVE", endedAt: null, lastActivityAt/.test(app), "resuming makes it live, cancels the invoice countdown and counts as activity");
assert.ok(app.includes("onSubmit={(event) => { if (confirm && !window.confirm(confirm)) event.preventDefault(); }}"), "buttons can ask first");
assert.ok(/intent="end"[^>]*confirm=/.test(app), "ending a show asks first");
assert.ok(app.includes('intent="resume" label="Resume the show"'), "an ended show has a Resume button");
assert.ok(app.includes("This show has ended,") && app.includes("Press <strong>Resume the show</strong>"), "and says why the item buttons are gone");
assert.ok(app.includes("Pressed End by mistake? Press Resume the show."), "the message after ending mentions it");
assert.ok(api.includes('intent === "resume"') && /status: "LIVE", endedAt: null, lastActivityAt/.test(api), "the Studio can resume a show");
assert.ok(studio.includes("async function resumeNow()") && studio.includes("Resume the show"), "and has the button");
console.log("Show resume: all checks passed");
