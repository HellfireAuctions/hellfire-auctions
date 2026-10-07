import assert from "node:assert/strict";
import { viewFromPath, auctionState, countByState, filterAuctions, FILTER_LABELS, VIEWS } from "../app/admin-view.js";

// ---------- which page is this ----------
assert.equal(viewFromPath("/app"), VIEWS.HOME, "the setup guide is the home page");
assert.equal(viewFromPath("/app/"), VIEWS.HOME);
assert.equal(viewFromPath("/app/add-auction"), VIEWS.ADD);
assert.equal(viewFromPath("/app/add-auction/"), VIEWS.ADD, "a trailing slash");
assert.equal(viewFromPath("/app/add-auction?edit=abc"), VIEWS.ADD, "a query is ignored");
assert.equal(viewFromPath("/app/auctions"), VIEWS.AUCTIONS);
assert.equal(viewFromPath("/app/auctions?removed=1"), VIEWS.AUCTIONS);
assert.equal(viewFromPath("/app/settings"), VIEWS.SETTINGS);
assert.equal(viewFromPath("/app/live"), VIEWS.HOME, "other pages have their own routes and never reach this component");
for (const odd of ["", null, undefined, "/", "/something/else", "/app/auctions/extra"]) assert.equal(viewFromPath(odd), VIEWS.HOME, String(odd));

// ---------- running, upcoming, ended ----------
const now = Date.parse("2026-10-08T12:00:00Z");
const at = (h) => new Date(now + h * 3_600_000).toISOString();
const A = (id, s, e) => ({ id, startsAt: at(s), endsAt: at(e) });
assert.equal(auctionState(A("a", -1, 1), now), "LIVE");
assert.equal(auctionState(A("a", 1, 5), now), "UPCOMING");
assert.equal(auctionState(A("a", -5, -1), now), "ENDED");
assert.equal(auctionState({ startsAt: at(0), endsAt: at(1) }, now), "LIVE", "starting this very moment is running");
assert.equal(auctionState({ startsAt: at(-1), endsAt: at(0) }, now), "ENDED", "ending this very moment is ended");

const list = [A("run1", -2, 2), A("run2", -1, 30), A("up1", 3, 9), A("end1", -9, -3), A("end2", -20, -10), A("end3", -30, -20)];
assert.deepEqual(countByState(list, now), { LIVE: 2, UPCOMING: 1, ENDED: 3, ALL: 6 });
assert.deepEqual(filterAuctions(list, "LIVE", now).map((a) => a.id), ["run1", "run2"], "running auctions only, in their original order");
assert.deepEqual(filterAuctions(list, "UPCOMING", now).map((a) => a.id), ["up1"]);
assert.deepEqual(filterAuctions(list, "ENDED", now).map((a) => a.id), ["end1", "end2", "end3"]);
assert.equal(filterAuctions(list, "ALL", now).length, 6);
assert.equal(filterAuctions(list, null, now).length, 6, "no filter shows everything");
assert.equal(filterAuctions(list, undefined, now).length, 6);
assert.deepEqual(countByState([], now), { LIVE: 0, UPCOMING: 0, ENDED: 0, ALL: 0 });
assert.deepEqual(countByState(null, now), { LIVE: 0, UPCOMING: 0, ENDED: 0, ALL: 0 }, "no list at all never crashes");
assert.deepEqual(filterAuctions(undefined, "LIVE", now), []);

// every filter the page offers has a label, and the counts add up
assert.deepEqual(Object.keys(FILTER_LABELS).sort(), ["ALL", "ENDED", "LIVE", "UPCOMING"]);
const c = countByState(list, now);
assert.equal(c.LIVE + c.UPCOMING + c.ENDED, c.ALL);
assert.equal(FILTER_LABELS.LIVE, "Running");

console.log("Admin pages: all checks passed");
