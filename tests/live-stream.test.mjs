import assert from "node:assert/strict";
import { liveStreamResponse, liveStreamUrl } from "../app/live-stream.server.js";
import { publish, subscribe, connectionCount, roomCount, resetHub } from "../app/live-hub.server.js";
import { liveToken } from "../app/live-token.js";

const S = "test-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
resetHub();

function open(auctionId = "auction-1", opts = {}) {
  const ac = new AbortController();
  const res = liveStreamResponse({
    auctionId,
    token: opts.token ?? liveToken(auctionId, S),
    signal: ac.signal,
    secret: S,
    heartbeatMs: opts.heartbeatMs ?? 60_000,
    maxConnections: opts.max ?? 3000,
  });
  return { ac, res, reader: res.body ? res.body.getReader() : null };
}
// One read stays pending per connection between calls, so a read that was abandoned at a timeout can never swallow
// the next real message.
const readers = new WeakMap();
async function readUntil(reader, done, ms = 1500) {
  let st = readers.get(reader);
  if (!st) readers.set(reader, (st = { pending: null, left: "", decoder: new TextDecoder() }));
  let text = st.left;
  st.left = "";
  const end = Date.now() + ms;
  while (Date.now() < end && !done(text)) {
    if (!st.pending) st.pending = reader.read();
    const r = await Promise.race([st.pending, sleep(Math.max(1, end - Date.now())).then(() => ({ timeout: true }))]);
    if (r.timeout) break;
    st.pending = null;
    if (r.done) break;
    text += st.decoder.decode(r.value);
  }
  return text;
}

// ---------- refused connections ----------
for (const [name, token] of [["a wrong pass", "0".repeat(40)], ["no pass", ""], ["another auction's pass", liveToken("auction-2", S)]]) {
  const { res } = open("auction-1", { token });
  assert.equal(res.status, 403, name);
  assert.equal(res.headers.get("access-control-allow-origin"), "*", name + ": the browser must be able to read the refusal");
}
assert.equal(connectionCount(), 0, "refused connections are never counted");

// ---------- a good connection ----------
const a = open();
assert.equal(a.res.status, 200);
assert.match(a.res.headers.get("content-type"), /text\/event-stream/);
assert.match(a.res.headers.get("cache-control"), /no-cache/);
assert.match(a.res.headers.get("cache-control"), /no-transform/, "no-transform keeps the server's compression from holding events back");
assert.equal(a.res.headers.get("access-control-allow-origin"), "*");
const first = await readUntil(a.reader, (t) => t.includes("event: hello"));
assert.ok(first.includes("retry: 3000"), "tells the browser how fast to reconnect");
assert.ok(first.includes("event: hello"), "says hello straight away, so the page knows the connection works end to end");
assert.equal(JSON.parse(/event: hello\ndata: (\{.*\})/.exec(first)[1]).n, 1, "hello says how many are watching");
assert.equal(connectionCount(), 1);
assert.equal(roomCount(), 1);

// ---------- an update reaches the right viewers only ----------
assert.equal(publish("auction-1"), 1, "one viewer was told");
const update = await readUntil(a.reader, (t) => t.includes("event: update"));
assert.ok(update.includes("event: update"));
const data = JSON.parse(/data: (\{.*\})/.exec(update)[1]);
assert.equal(data.id, "auction-1");
assert.ok(Number.isInteger(data.seq) && data.seq > 0 && data.at > 0);
assert.ok(!/bidder|customer|email|amount|price/i.test(update), "nothing personal or financial is ever sent on this connection");

assert.equal(publish("some-other-auction"), 0, "nobody watches the other auction");
const nothing = await readUntil(a.reader, (t) => t.includes("event: update"), 150);
assert.ok(!nothing.includes("event: update"), "an update for another auction never arrives here");

// ---------- several viewers ----------
const b = open();
await readUntil(b.reader, (t) => t.includes("event: hello"));
assert.equal(connectionCount(), 2);
assert.equal(publish("auction-1"), 2, "both were told");
const ua = await readUntil(a.reader, (t) => t.includes("event: update"));
const ub = await readUntil(b.reader, (t) => t.includes("event: update"));
assert.ok(ua.includes("event: update") && ub.includes("event: update"));
assert.equal(JSON.parse(/event: update\ndata: (\{.*\})/.exec(ua)[1]).n, 2, "an update says how many are watching, so big crowds can spread out");

// ---------- leaving cleans up ----------
a.ac.abort();
await sleep(30);
assert.equal(connectionCount(), 1, "a closed tab is forgotten straight away");
assert.equal(publish("auction-1"), 1);
await b.reader.cancel();
await sleep(30);
assert.equal(connectionCount(), 0, "cancelling also cleans up");
assert.equal(roomCount(), 0, "empty rooms are removed, so nothing piles up");
assert.equal(publish("auction-1"), 0);

// ---------- heartbeat keeps the connection from going quiet ----------
const hb = open("auction-1", { heartbeatMs: 40 });
const beats = await readUntil(hb.reader, (t) => (t.match(/event: ping/g) || []).length >= 2, 800);
assert.ok((beats.match(/event: ping/g) || []).length >= 2, "pings keep arriving");
hb.ac.abort();
await sleep(30);
assert.equal(connectionCount(), 0);

// ---------- a full server says "busy" instead of falling over ----------
const full1 = open("auction-1", { max: 1 });
await readUntil(full1.reader, (t) => t.includes("event: hello"));
const full2 = open("auction-1", { max: 1 });
assert.equal(full2.res.status, 503);
assert.equal(full2.res.headers.get("retry-after"), "30");
assert.equal(connectionCount(), 1, "the refused one is not counted");
full1.ac.abort();
await sleep(30);
assert.equal(connectionCount(), 0);

// ---------- a connection that is already closed when it starts is cleaned up ----------
const ac = new AbortController();
ac.abort();
const dead = liveStreamResponse({ auctionId: "auction-1", token: liveToken("auction-1", S), signal: ac.signal, secret: S, heartbeatMs: 60_000 });
await sleep(30);
assert.equal(connectionCount(), 0, "no leftover connection");
assert.equal(dead.status, 200);

// ---------- the hub itself ----------
resetHub();
const got = [];
const off1 = subscribe("x", (kind) => got.push(["one", kind]));
const off2 = subscribe("x", () => {
  throw new Error("a broken viewer");
});
const off3 = subscribe("x", (kind) => got.push(["three", kind]));
assert.equal(connectionCount(), 3);
assert.equal(publish("x", "update"), 2, "a broken viewer does not stop the others (it is just not counted)");
assert.deepEqual(got, [["one", "update"], ["three", "update"]]);
off1();
off1(); // leaving twice is harmless
assert.equal(connectionCount(), 2);
off2();
off3();
assert.equal(connectionCount(), 0);
assert.equal(roomCount(), 0);

// ---------- the address the page connects to ----------
const url = liveStreamUrl("auction-1", "https://app.example.com/", S);
assert.equal(url, `https://app.example.com/api/stream/auction-1?t=${liveToken("auction-1", S)}`, "no double slash");
assert.ok(liveStreamUrl("a b/c", "https://x.test", S).includes("/api/stream/a%20b%2Fc?t="), "odd characters are encoded");
assert.equal(liveStreamUrl("auction-1", "https://x.test", ""), null, "no secret means no address");
assert.equal(liveStreamUrl("auction-1", "", S), null, "no origin means no address");
assert.equal(liveStreamUrl("", "https://x.test", S), null);

// ---------- the emergency off switch ----------
process.env.HELLFIRE_LIVE = "off";
assert.equal(liveStreamUrl("auction-1", "https://x.test", S), null, "off: no addresses are handed out");
const off = liveStreamResponse({ auctionId: "auction-1", token: liveToken("auction-1", S), secret: S });
assert.equal(off.status, 503, "off: new connections are refused");
assert.equal(off.headers.get("access-control-allow-origin"), "*");
assert.equal(connectionCount(), 0);
process.env.HELLFIRE_LIVE = "on";
assert.ok(liveStreamUrl("auction-1", "https://x.test", S), "on again: addresses are handed out");
delete process.env.HELLFIRE_LIVE;
assert.ok(liveStreamUrl("auction-1", "https://x.test", S), "unset means on");

console.log("Live connection: all checks passed");
