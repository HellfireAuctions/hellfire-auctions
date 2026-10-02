// Checks the admin's time-zone conversion using the real functions from app/routes/app._index.jsx.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/routes/app._index.jsx", import.meta.url), "utf8");
const start = source.indexOf("const DEFAULT_TZ");
const end = source.indexOf("async function uploadImage");
const helpers = new Function(
  source.slice(start, end) + "; return { easternLocalToUtc, getEasternParts, formatEastern };",
)();

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log("ok -", name); };
const toUtc = (d, h, m, ap, tz) => helpers.easternLocalToUtc(d, h, m, ap, tz).toISOString();

check("New York summer: 7:00 PM EDT = 23:00 UTC", () =>
  assert.equal(toUtc("2026-10-02", "7", "00", "PM", "America/New_York"), "2026-10-02T23:00:00.000Z"));
check("New York winter: 7:00 PM EST = 00:00 UTC next day", () =>
  assert.equal(toUtc("2026-12-01", "7", "00", "PM", "America/New_York"), "2026-12-02T00:00:00.000Z"));
check("New York spring-forward day: 3:30 AM EDT = 07:30 UTC", () =>
  assert.equal(toUtc("2026-03-08", "3", "30", "AM", "America/New_York"), "2026-03-08T07:30:00.000Z"));
check("Los Angeles: 9:15 AM PDT = 16:15 UTC", () =>
  assert.equal(toUtc("2026-10-02", "9", "15", "AM", "America/Los_Angeles"), "2026-10-02T16:15:00.000Z"));
check("London summer: 12:00 PM BST = 11:00 UTC", () =>
  assert.equal(toUtc("2026-07-01", "12", "00", "PM", "Europe/London"), "2026-07-01T11:00:00.000Z"));
check("Sydney: 9:00 AM AEDT = 22:00 UTC previous day", () =>
  assert.equal(toUtc("2026-10-10", "9", "00", "AM", "Australia/Sydney"), "2026-10-09T22:00:00.000Z"));
check("12:00 AM is midnight, 12:00 PM is noon", () => {
  assert.equal(toUtc("2026-10-02", "12", "00", "AM", "UTC"), "2026-10-02T00:00:00.000Z");
  assert.equal(toUtc("2026-10-02", "12", "00", "PM", "UTC"), "2026-10-02T12:00:00.000Z");
});
check("Round trip: stored time shows back the same in the form", () => {
  for (const tz of ["America/New_York", "America/Chicago", "Europe/Berlin", "Asia/Tokyo"]) {
    const utc = helpers.easternLocalToUtc("2026-11-20", "8", "45", "PM", tz);
    const parts = helpers.getEasternParts(utc, tz);
    assert.deepEqual([parts.date, parts.hour, parts.minute, parts.ampm], ["2026-11-20", "8", "45", "PM"], tz);
  }
});
check("Default with no time zone is still Eastern (your store's current behaviour)", () =>
  assert.equal(helpers.easternLocalToUtc("2026-10-02", "7", "00", "PM").toISOString(), "2026-10-02T23:00:00.000Z"));

console.log(`\n${passed} time-zone checks passed`);
