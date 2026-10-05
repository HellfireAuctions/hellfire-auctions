import assert from "node:assert/strict";
import { memo, memoReset, memoDelete } from "../app/memo.server.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. a crowd asking at the same instant costs ONE fetch, and everyone gets the same answer
memoReset();
let calls = 0;
const slow = async () => { calls += 1; await sleep(40); return { n: calls }; };
const crowd = await Promise.all(Array.from({ length: 200 }, () => memo("a", 1000, slow)));
assert.equal(calls, 1, "200 simultaneous requests made " + calls + " database trips");
assert.ok(crowd.every((r) => r === crowd[0]), "everyone shares the same answer");

// 2. the answer is reused while it is fresh, then fetched again once it is stale
assert.equal(await memo("a", 1000, slow), crowd[0]);
assert.equal(calls, 1);
await sleep(30);
let fresh = 0;
const quick = async () => { fresh += 1; return "x"; };
await memo("b", 50, quick);
await memo("b", 50, quick);
assert.equal(fresh, 1, "still fresh");
await sleep(70);
await memo("b", 50, quick);
assert.equal(fresh, 2, "stale after its time");

// 3. a fetch that is slower than the cache time is still shared (no second stampede while it is under way)
memoReset();
let slowCalls = 0;
const verySlow = async () => { slowCalls += 1; await sleep(120); return slowCalls; };
const first = memo("c", 30, verySlow);
await sleep(60); // older than 30 ms, but the first fetch has not finished
const second = memo("c", 30, verySlow);
assert.equal(await first, await second);
assert.equal(slowCalls, 1, "a slow fetch must not start a second one");

// 4. a failure is never kept: the next request tries again
memoReset();
let attempts = 0;
const flaky = async () => { attempts += 1; if (attempts === 1) throw new Error("database hiccup"); return "ok"; };
await assert.rejects(() => memo("d", 1000, flaky), /database hiccup/);
await sleep(5);
assert.equal(await memo("d", 1000, flaky), "ok");
assert.equal(attempts, 2);

// 5. everyone waiting on a failed fetch gets the failure (and then the next one retries)
memoReset();
let boom = 0;
const failing = async () => { boom += 1; await sleep(20); throw new Error("down"); };
const results = await Promise.allSettled(Array.from({ length: 5 }, () => memo("e", 1000, failing)));
assert.equal(boom, 1);
assert.ok(results.every((r) => r.status === "rejected"));

// 6. different keys never mix
memoReset();
assert.equal(await memo("k1", 1000, async () => 1), 1);
assert.equal(await memo("k2", 1000, async () => 2), 2);
assert.equal(await memo("k1", 1000, async () => 99), 1);

// 7. a thrown error inside the function (not a rejected promise) is also handled
memoReset();
await assert.rejects(() => memo("f", 1000, () => { throw new Error("sync boom"); }), /sync boom/);
await sleep(5);
assert.equal(await memo("f", 1000, async () => "recovered"), "recovered");

console.log("Shared answers (memo): all checks passed");

// 8. forgetting an answer makes the next request fetch fresh data (this is what a new bid does)
memoReset();
let version = 0;
const versioned = async () => { version += 1; return version; };
assert.equal(await memo("g", 60000, versioned), 1);
assert.equal(await memo("g", 60000, versioned), 1, "still shared");
memoDelete("g");
assert.equal(await memo("g", 60000, versioned), 2, "fresh after being forgotten");
memoDelete("never-existed"); // forgetting something unknown is harmless
console.log("Shared answers: forgetting works");
