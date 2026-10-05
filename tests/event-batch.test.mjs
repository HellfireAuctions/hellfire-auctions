import assert from "node:assert/strict";
import { addMinutesLocal, checkBatchTimes, planBatch } from "../app/event-schedule.js";

assert.equal(addMinutesLocal("2026-10-09T21:00", 8), "2026-10-09T21:08");
assert.equal(addMinutesLocal("2026-10-09T23:55", 10), "2026-10-10T00:05");
assert.equal(addMinutesLocal("2026-12-31T23:59", 1), "2027-01-01T00:00");
assert.equal(addMinutesLocal("2026-10-30T20:00", 7 * 1440), "2026-11-06T20:00", "same wall-clock time a week later, across the clock change");
assert.equal(addMinutesLocal("2026-03-01T20:00", 28 * 1440), "2026-03-29T20:00");
assert.equal(addMinutesLocal("nonsense", 5), null);

const base = { count: 3, startLocal: "2026-10-09T19:00", firstEndLocal: "2026-10-09T21:00", gapMinutes: 8, weeks: 1 };
assert.equal(checkBatchTimes(base), null);
assert.match(checkBatchTimes({ ...base, count: 0 }), /no valid rows/);
assert.match(checkBatchTimes({ ...base, weeks: 0 }), /between 1 and 8/);
assert.match(checkBatchTimes({ ...base, weeks: 9 }), /between 1 and 8/);
assert.match(checkBatchTimes({ ...base, weeks: 1.5 }), /between 1 and 8/);
assert.match(checkBatchTimes({ ...base, count: 100, weeks: 3 }), /up to 200/);
assert.match(checkBatchTimes({ ...base, gapMinutes: 0 }), /between 1 and 1440/);
assert.match(checkBatchTimes({ ...base, startLocal: "" }), /Choose when/);
assert.match(checkBatchTimes({ ...base, firstEndLocal: "2026-10-09T19:30" }), /at least 1 hour/);
assert.equal(checkBatchTimes({ ...base, firstEndLocal: "2026-10-09T20:00" }), null);

const jobs = planBatch({ ...base, weeks: 2 });
assert.equal(jobs.length, 6);
assert.deepEqual(jobs.map((j) => j.index), [0, 1, 2, 0, 1, 2]);
assert.deepEqual(jobs.map((j) => j.week), [0, 0, 0, 1, 1, 1]);
assert.equal(jobs[0].endLocal, "2026-10-09T21:00");
assert.equal(jobs[1].endLocal, "2026-10-09T21:08");
assert.equal(jobs[2].endLocal, "2026-10-09T21:16");
assert.equal(jobs[3].startLocal, "2026-10-16T19:00");
assert.equal(jobs[3].endLocal, "2026-10-16T21:00");
assert.equal(jobs[5].endLocal, "2026-10-16T21:16");
assert.ok(jobs.every((j) => j.startLocal === (j.week === 0 ? "2026-10-09T19:00" : "2026-10-16T19:00")));
console.log("Batch planning: all checks passed");
