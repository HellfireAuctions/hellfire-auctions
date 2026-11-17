import assert from "node:assert/strict";
import fs from "node:fs";
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const claim = read("app/routes/api.proxy.live-claim.jsx");
assert.ok(claim.includes('memo("blocked:" + shop + ":" + customerId, 5_000'), "the blocked check is remembered for 5 seconds");
assert.ok(claim.includes('memo(verdictKey, 15_000, () => checkBidder('), "a 'yes' is remembered for 15 seconds");
assert.ok(claim.includes("memoDelete(verdictKey);") && claim.indexOf("memoDelete(verdictKey);") < claim.indexOf("return reply({ ok: false, message: verdict.message }, 403);"), "a 'no' is never remembered");
assert.ok(claim.indexOf("memo(verdictKey") < claim.indexOf("await claimDrop("), "and the decision still happens before the claim itself, which is still one locked transaction");
const action = read("app/action-sale.server.js");
assert.ok(action.includes('FOR UPDATE') && action.includes("db.$transaction"), "claims are still locked, so two shoppers can never get the same unit");

// the pool: the same rule as the server, tested directly
const dbSrc = read("app/db.server.js");
const body = dbSrc.slice(dbSrc.indexOf("export function withPool"), dbSrc.indexOf("const datasourceUrl"));
const withPool = new Function(body.replace("export function", "function") + "; return withPool;")();
assert.equal(withPool("postgresql://u:p@h/db?sslmode=require"), "postgresql://u:p@h/db?sslmode=require&connection_limit=15&pool_timeout=20");
assert.equal(withPool("postgresql://u:p@h/db"), "postgresql://u:p@h/db?connection_limit=15&pool_timeout=20");
assert.equal(withPool("postgresql://u:p@h/db?connection_limit=4"), "postgresql://u:p@h/db?connection_limit=4", "an address that already sets a limit is left alone");
assert.equal(withPool("postgresql://u:p@h/db?x=1&connection_limit=4"), "postgresql://u:p@h/db?x=1&connection_limit=4");
assert.equal(withPool(undefined), undefined);
assert.ok(dbSrc.includes("const datasourceUrl = withPool(useNeon"), "and it is used");

const room = read("app/routes/api.proxy.live.jsx");
assert.ok(room.includes("var t = setTimeout(resolve, 1200);"), "the room asks for video sooner");
assert.ok(room.includes("Connecting to the live video...") && room.includes('live.video.addEventListener("playing"'), "the room says it is connecting until the picture plays");
console.log("Live speed: all checks passed");
