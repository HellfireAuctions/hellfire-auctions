import assert from "node:assert/strict";
import { readAuctionRows, CSV_TEMPLATE } from "../app/csv-import.js";

const read = (header, ...lines) => readAuctionRows([header, ...lines].join("\n"));
const H = "title,starting bid,reserve price,buy it now price,image url";
const IMG = "https://example.com/a.jpg";

// ---------- the column is recognised under its usual names ----------
for (const name of ["Buy It Now Price", "buy it now", "Buy Now", "BIN", "Buyout", "buy_now_price", "Buy-It-Now"]) {
  const r = read(`title,starting bid,${name},image url`, `Frag,10,50,${IMG}`);
  assert.equal(r.rows[0].data.buyNowPrice, 50, name);
  assert.deepEqual(r.rows[0].problems, [], name);
}

// ---------- values ----------
let r = read(H, `Frag,25,60,90,${IMG}`);
assert.deepEqual(r.rows[0].problems, []);
assert.equal(r.rows[0].data.buyNowPrice, 90);
assert.equal(read(H, `Frag,25,,90,${IMG}`).rows[0].data.buyNowPrice, 90, "no reserve is fine");
assert.equal(read(H, `Frag,25,,"$1,200.50",${IMG}`).rows[0].data.buyNowPrice, 1200.5, "a price with a currency sign and thousands separator");
assert.equal(read(H, `Frag,25,60,,${IMG}`).rows[0].data.buyNowPrice, null, "empty means no Buy It Now");
assert.deepEqual(read(H, `Frag,25,60,,${IMG}`).rows[0].problems, []);
assert.equal(read(`title,starting bid,image url`, `Frag,25,${IMG}`).rows[0].data.buyNowPrice, null, "a file without the column");
assert.equal(read(H, `Frag,25,,49.999,${IMG}`).rows[0].data.buyNowPrice, 50, "rounded to cents");

// ---------- mistakes are reported on the row, in plain words ----------
const problem = (cell, reserve = "") => read(H, `Frag,25,${reserve},${cell},${IMG}`).rows[0].problems.join(" | ");
assert.match(problem("25"), /starting bid/, "equal to the starting bid");
assert.match(problem("10"), /starting bid/, "below the starting bid");
assert.match(problem("50", "60"), /reserve/, "below the reserve");
assert.equal(problem("60", "60"), "", "equal to the reserve is allowed");
assert.match(problem("abc"), /valid Buy It Now/);
assert.match(problem("0"), /valid Buy It Now/);
assert.match(problem("100000"), /99,999/);
assert.ok(!/NaN|undefined/.test(problem("abc") + problem("10") + problem("50", "60")));

// a bad Buy It Now price only invalidates its own row
r = read(H, `Good,25,,40,${IMG}`, `Bad,25,,5,${IMG}`, `Also good,30,,,${IMG}`);
assert.deepEqual(r.rows.map((x) => x.problems.length), [0, 1, 0]);

// ---------- the downloadable template shows the new column and still parses cleanly ----------
assert.match(CSV_TEMPLATE.split("\n")[0], /buy it now price/);
r = readAuctionRows(CSV_TEMPLATE);
assert.deepEqual(r.missingColumns, []);
assert.equal(r.rows.length, 2);
assert.deepEqual(r.rows.map((x) => x.problems), [[], []]);
assert.equal(r.rows[0].data.buyNowPrice, 90);
assert.equal(r.rows[1].data.buyNowPrice, null);
assert.equal(r.rows[0].data.reservePrice, 60);
assert.equal(r.rows[0].data.weightValue, 4, "the other columns still line up after the new one");
assert.equal(r.rows[1].data.weightUnit, "OUNCES");

// European Excel (semicolons) works too
r = readAuctionRows(`title;starting bid;buy it now price;image url\nFrag;25;90;${IMG}`);
assert.equal(r.rows[0].data.buyNowPrice, 90);

console.log("CSV Buy It Now column: all checks passed");
