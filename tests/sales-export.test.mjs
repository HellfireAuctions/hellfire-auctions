import assert from "node:assert/strict";
import { csvCell, saleStatus, buildSalesCsv, SALES_HEADER } from "../app/sales-export.js";
import { parseCsv } from "../app/csv-import.js";

const H = 3600_000;
const now = Date.UTC(2026, 9, 20, 12, 0);
const base = { id: "a1", title: "Coral", status: "ENDED", startsAt: new Date(now - 10 * 24 * H), endsAt: new Date(now - 5 * 24 * H), startingBid: 10, currentBid: 10, bidCount: 0, reservePrice: null, winnerId: null, winnerNotifiedAt: null, isTest: false };

// cells: quoting, and spreadsheet formulas are defused
assert.equal(csvCell("plain"), "plain");
assert.equal(csvCell("a,b"), '"a,b"');
assert.equal(csvCell('say "hi"'), '"say ""hi"""');
assert.equal(csvCell("two\nlines"), '"two\nlines"');
assert.equal(csvCell("=HYPERLINK(\"http://evil\")"), "\"'=HYPERLINK(\"\"http://evil\"\")\"");
assert.equal(csvCell("+1 coral"), "'+1 coral");
assert.equal(csvCell("-5 off"), "'-5 off");
assert.equal(csvCell("@sum"), "'@sum");
assert.equal(csvCell(null), "");
assert.equal(csvCell(0), "0");

// every kind of status
assert.equal(saleStatus({ ...base, status: "CANCELLED" }, undefined, now), "Cancelled");
assert.equal(saleStatus({ ...base, startsAt: new Date(now + H), endsAt: new Date(now + 48 * H), status: "UPCOMING" }, undefined, now), "Upcoming");
assert.equal(saleStatus({ ...base, startsAt: new Date(now - H), endsAt: new Date(now + 48 * H), status: "LIVE" }, undefined, now), "Live");
assert.equal(saleStatus({ ...base, isTest: true }, undefined, now), "Test (no sale)");
assert.equal(saleStatus(base, undefined, now), "Unsold");
assert.equal(saleStatus({ ...base, winnerId: "9", winnerNotifiedAt: new Date(now - 5 * 24 * H) }, new Date(now - 4 * 24 * H), now), "Sold - paid");
assert.equal(saleStatus({ ...base, winnerId: "9", winnerNotifiedAt: new Date(now - 5 * 24 * H) }, undefined, now), "Sold - unpaid (deadline passed)");
assert.equal(saleStatus({ ...base, winnerId: "9", winnerNotifiedAt: new Date(now - 1 * 24 * H) }, undefined, now), "Sold - awaiting payment");

// a whole report, read back with the same reader the app uses for imports
const sold = { ...base, id: "s1", title: 'Big, "bold" coral', currentBid: 87.5, bidCount: 9, reservePrice: 50, winnerId: "777", winnerNotifiedAt: new Date(now - 5 * 24 * H) };
const unsold = { ...base, id: "u1", title: "=SUM(A1)", startingBid: 25 };
const csv = buildSalesCsv([sold, unsold], new Map([["s1", new Date(now - 4 * 24 * H)]]), now);
assert.ok(csv.startsWith("\uFEFF"), "byte-order mark for Excel");
assert.ok(csv.endsWith("\r\n"));
const grid = parseCsv(csv);
assert.equal(grid.length, 3);
assert.deepEqual(grid[0], SALES_HEADER);
assert.equal(grid[1][1], 'Big, "bold" coral');
assert.equal(grid[1][2], "Sold - paid");
assert.equal(grid[1][5], "10.00");
assert.equal(grid[1][6], "87.50");
assert.equal(grid[1][7], "9");
assert.equal(grid[1][8], "yes");
assert.equal(grid[1][9], "777");
assert.equal(grid[1][10], new Date(now - 4 * 24 * H).toISOString());
assert.equal(grid[2][1], "'=SUM(A1)");
assert.equal(grid[2][2], "Unsold");
assert.equal(grid[2][6], "", "an unsold auction has no final price");
assert.equal(grid[2][9], "", "and no winner");
assert.equal(grid[2][8], "no");
console.log("Sales report: all checks passed");
