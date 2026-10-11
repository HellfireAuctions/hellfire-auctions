import assert from "node:assert/strict";
import fs from "node:fs";

// The database (Neon) sleeps after 5 quiet minutes. A background check more often than that keeps it awake all month.
const src = fs.readFileSync("app/drops-followup.server.js", "utf8");
const m = /export const QUIET_PASS_MS = (\d+) \* 60_000;/.exec(src);
assert.ok(m, "the quiet interval is a named setting");
assert.ok(Number(m[1]) >= 30, "a quiet store is checked no more often than every 30 minutes (Neon sleeps after 5)");
assert.ok(src.includes("now - lastRun < QUIET_PASS_MS"), "and the timer uses it");
assert.ok(!/now - lastRun < 10 \* 60_000/.test(src), "the old 10-minute rhythm is gone");
console.log("Quiet timer: all checks passed");
