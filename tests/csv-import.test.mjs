import assert from "node:assert/strict";
import { parseCsv, readAuctionRows, CSV_TEMPLATE, MAX_ROWS } from "../app/csv-import.js";

// the parser
assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""'), [["a", "b"], ["x, y", 'say "hi"']]);
assert.deepEqual(parseCsv('a\n"line one\nline two"'), [["a"], ["line one\nline two"]]);
assert.deepEqual(parseCsv("\uFEFFa,b\n1,2"), [["a", "b"], ["1", "2"]], "Excel's byte-order mark");
assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]], "semicolons (European Excel)");
assert.deepEqual(parseCsv("a,b\n\n  ,  \n1,2"), [["a", "b"], ["1", "2"]], "blank lines are skipped");
assert.deepEqual(parseCsv(""), []);

// the template we give people must itself import cleanly
const t = readAuctionRows(CSV_TEMPLATE);
assert.equal(t.missingColumns.length, 0);
assert.equal(t.rows.length, 2);
assert.ok(t.rows.every((r) => r.problems.length === 0), JSON.stringify(t.rows.map((r) => r.problems)));
assert.equal(t.rows[0].data.title, "Rainbow Zoanthid frag");
assert.equal(t.rows[0].data.description, "Colony of 10 polyps, healthy and growing");
assert.equal(t.rows[0].data.startingBid, 25);
assert.equal(t.rows[0].data.reservePrice, 60);
assert.equal(t.rows[0].data.weightValue, 4);
assert.equal(t.rows[0].data.weightUnit, "OUNCES");
assert.equal(t.rows[1].data.reservePrice, null);

// different spellings of the headers
const alt = readAuctionRows("Name,Start Price,Photo,Reserve,Shipping Weight,Unit\nCoral,$1,250.50,https://x.test/a.jpg,\"$2,000\",2,lbs");
assert.equal(alt.missingColumns.length, 0);
assert.equal(alt.rows[0].data.title, "Coral");

const quoted = readAuctionRows('Title,Starting Bid,Image URL\n"Big, bold coral",1250.50,https://x.test/a.jpg');
assert.equal(quoted.rows[0].data.startingBid, 1250.5);
assert.equal(quoted.rows[0].problems.length, 0);

// every kind of problem is explained per row
const bad = readAuctionRows([
  "title,starting bid,reserve price,image url,weight,weight unit",
  ",10,,https://x.test/a.jpg,,",
  "No price,abc,,https://x.test/a.jpg,,",
  "Low reserve,10,5,https://x.test/a.jpg,,",
  "No image,10,,not-a-link,,",
  "http image,10,,http://x.test/a.jpg,,",
  "Bad weight,10,,https://x.test/a.jpg,0,oz",
  "Bad unit,10,,https://x.test/a.jpg,5,stone",
  "Fine,10,20,https://x.test/a.jpg,5,KG",
].join("\n"));
const msgs = bad.rows.map((r) => r.problems.join(" | "));
assert.match(msgs[0], /Missing title/);
assert.match(msgs[1], /Starting bid/);
assert.match(msgs[2], /Reserve price must be higher/);
assert.match(msgs[3], /Image link/);
assert.match(msgs[4], /Image link/);
assert.match(msgs[5], /Weight must be/);
assert.match(msgs[6], /Unknown weight unit/);
assert.equal(msgs[7], "");
assert.equal(bad.rows[7].data.weightUnit, "KILOGRAMS");
assert.equal(bad.rows[0].line, 2);
assert.equal(bad.rows[7].line, 9);

// missing columns and limits
const noImage = readAuctionRows("title,starting bid\nCoral,10");
assert.deepEqual(noImage.missingColumns, ["imageUrl"]);
assert.deepEqual(readAuctionRows("").missingColumns, ["title", "startingBid", "imageUrl"]);
const many = readAuctionRows("title,starting bid,image url\n" + Array.from({ length: MAX_ROWS + 5 }, (_, i) => `Lot ${i},10,https://x.test/${i}.jpg`).join("\n"));
assert.equal(many.rows.length, MAX_ROWS);
assert.equal(many.tooMany, true);
assert.equal(many.total, MAX_ROWS + 5);
console.log("CSV import: all checks passed");
