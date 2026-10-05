import assert from "node:assert/strict";
import { parseStoreLocal, staggeredEnds, validateEvent } from "../app/event-schedule.js";

// datetime-local values become the pieces the app's own time helper expects
assert.deepEqual(parseStoreLocal("2026-10-09T19:00"), { date: "2026-10-09", hour: "7", minute: "00", ampm: "PM" });
assert.deepEqual(parseStoreLocal("2026-10-09T00:05"), { date: "2026-10-09", hour: "12", minute: "05", ampm: "AM" });
assert.deepEqual(parseStoreLocal("2026-10-09T12:30"), { date: "2026-10-09", hour: "12", minute: "30", ampm: "PM" });
assert.deepEqual(parseStoreLocal("2026-10-09T23:59"), { date: "2026-10-09", hour: "11", minute: "59", ampm: "PM" });
assert.equal(parseStoreLocal("2026-10-09"), null);
assert.equal(parseStoreLocal("2026-10-09T24:00"), null);
assert.equal(parseStoreLocal("2026-10-09T10:75"), null);
assert.equal(parseStoreLocal(""), null);
assert.equal(parseStoreLocal(null), null);

// twelve lots, eight minutes apart
const first = Date.UTC(2026, 9, 10, 1, 0); // any instant
const ends = staggeredEnds(first, 8, 12);
assert.equal(ends.length, 12);
assert.equal(ends[0].getTime(), first);
assert.equal(ends[1].getTime() - ends[0].getTime(), 8 * 60_000);
assert.equal(ends[11].getTime() - first, 88 * 60_000);
assert.deepEqual(staggeredEnds(first, 8, 0), []);

const now = Date.UTC(2026, 9, 4, 12, 0);
const ok = { count: 12, gapMinutes: 8, startMs: now + 3 * 3600_000, firstEndMs: now + 5 * 3600_000, nowMs: now };
assert.equal(validateEvent(ok), null);
assert.match(validateEvent({ ...ok, count: 0 }), /at least one/);
assert.match(validateEvent({ ...ok, count: 101 }), /up to 100/);
assert.match(validateEvent({ ...ok, gapMinutes: 0 }), /between 1 and 1440/);
assert.match(validateEvent({ ...ok, gapMinutes: 2000 }), /between 1 and 1440/);
assert.match(validateEvent({ ...ok, gapMinutes: NaN }), /between 1 and 1440/);
assert.match(validateEvent({ ...ok, startMs: NaN }), /Choose when/);
assert.match(validateEvent({ ...ok, startMs: now - 3600_000 }), /already passed/);
assert.equal(validateEvent({ ...ok, startMs: now - 60_000, firstEndMs: now + 2 * 3600_000 }), null, "a start a minute ago means start now");
assert.match(validateEvent({ ...ok, firstEndMs: ok.startMs + 30 * 60_000 }), /at least 1 hour/);
assert.match(validateEvent({ ...ok, startMs: now - 60_000, firstEndMs: now + 30 * 60_000 }), /at least 1 hour/);
console.log("Event scheduling: all checks passed");
