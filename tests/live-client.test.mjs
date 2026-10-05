import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// The browser side of the live connection, run against a fake browser with a fake clock.
const source = fs.readFileSync(new URL("../extensions/hellfire-auctions-storefront/assets/auction.js", import.meta.url), "utf8");
const found = /\/\*LIVE:BEGIN\*\/([\s\S]*?)\/\*LIVE:END\*\//.exec(source);
assert.ok(found, "the live-connection code is marked in auction.js");
const code = found[1];

function harness(options = {}) {
  let now = 1_000_000;
  const timers = [];
  let nextId = 1;
  const instances = [];
  const refreshes = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      this.onerror = null;
      this.closed = false;
      instances.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    emit(type) {
      for (const fn of this.listeners[type] || []) fn({ type });
    }
    fail(readyState) {
      this.readyState = readyState;
      if (this.onerror) this.onerror({ type: "error" });
    }
  }

  const window = { __hfRefreshNow: () => refreshes.push(now) };
  const document = { hidden: false };
  const sandbox = {
    window,
    document,
    EventSource: options.throwing
      ? class {
          constructor() {
            throw new Error("EventSource is not available");
          }
        }
      : FakeEventSource,
    Date: { now: () => now },
    Math: { max: Math.max, random: () => 0.5 },
    setTimeout: (fn, ms) => {
      timers.push({ id: nextId++, at: now + ms, fn, every: 0 });
      return nextId;
    },
    setInterval: (fn, ms) => {
      timers.push({ id: nextId++, at: now + ms, fn, every: ms });
      return nextId;
    },
  };
  vm.runInNewContext(code, sandbox);

  function advance(ms) {
    const target = now + ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      const next = timers[0];
      if (!next || next.at > target) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else timers.shift();
      next.fn();
    }
    now = target;
  }
  const live = () => instances.filter((i) => !i.closed);
  return { window, document, instances, refreshes, advance, live, now: () => now };
}

// ---------- nothing happens without an address ----------
{
  const h = harness();
  h.advance(10_000);
  assert.equal(h.instances.length, 0, "no address, no connection");
  assert.ok(!h.window.__hfLiveOn);
}

// ---------- connecting, saying hello, and the polling slowdown flag ----------
{
  const h = harness();
  h.window.__hfLiveUrl = "https://app.test/api/stream/a1?t=one";
  h.advance(3_100);
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].url, "https://app.test/api/stream/a1?t=one");
  assert.equal(h.window.__hfLiveOn, false, "not live until the server has said hello (a silent middle-man must not slow polling)");
  h.instances[0].emit("hello");
  assert.equal(h.window.__hfLiveOn, true);

  // an update triggers a refresh within a moment, never two for a burst
  const before = h.refreshes.length;
  h.instances[0].emit("update");
  h.instances[0].emit("update");
  h.instances[0].emit("update");
  h.advance(100);
  assert.equal(h.refreshes.length, before, "waits a short random moment so viewers don't all refresh together");
  h.advance(400);
  assert.equal(h.refreshes.length, before + 1, "one refresh for the whole burst");

  // refreshes are spaced at least 1.5 seconds apart
  h.instances[0].emit("update");
  h.advance(1_000);
  assert.equal(h.refreshes.length, before + 1, "too soon after the last one");
  h.advance(1_000);
  assert.equal(h.refreshes.length, before + 2);

  // a hidden tab doesn't fetch (it catches up when shown)
  h.document.hidden = true;
  h.instances[0].emit("update");
  h.advance(3_000);
  assert.equal(h.refreshes.length, before + 2, "hidden tab: no refresh");
  h.document.hidden = false;
}

// ---------- pings keep it alive; silence means start over ----------
{
  const h = harness();
  h.window.__hfLiveUrl = "u1";
  h.advance(3_100);
  h.instances[0].emit("hello");
  for (let i = 0; i < 12; i += 1) {
    h.advance(15_000);
    h.instances[0].emit("ping");
  }
  assert.equal(h.instances.length, 1, "pings every 15 seconds: no reconnecting");
  assert.equal(h.window.__hfLiveOn, true);

  h.advance(45_000); // total silence
  assert.equal(h.instances[0].closed, true, "a silent connection is dropped");
  assert.equal(h.window.__hfLiveOn, false, "and polling goes back to normal speed");
  assert.equal(h.instances.length, 2, "and a fresh one is opened");
}

// ---------- errors ----------
{
  const h = harness();
  h.window.__hfLiveUrl = "u1";
  h.advance(3_100);
  h.instances[0].emit("hello");
  h.instances[0].fail(0); // a network blip: the browser retries by itself
  assert.equal(h.window.__hfLiveOn, false, "not live while it reconnects");
  assert.equal(h.instances[0].closed, false, "the browser's own retry is left alone");
  h.instances[0].emit("hello");
  assert.equal(h.window.__hfLiveOn, true, "live again once hello arrives");

  h.instances[0].fail(2); // refused (for example an expired pass)
  assert.equal(h.instances[0].closed, true);
  h.advance(3_100);
  assert.equal(h.instances.length, 2, "tries again with the same address on the next check");
}

// ---------- gives up after repeated failures, but a fresh pass starts over ----------
{
  const h = harness();
  h.window.__hfLiveUrl = "stale";
  for (let i = 0; i < 12; i += 1) {
    h.advance(3_100);
    const open = h.live()[0];
    if (open) open.fail(2);
  }
  const attempts = h.instances.length;
  assert.ok(attempts <= 7, `stops hammering a refusing server (tried ${attempts} times)`);
  h.advance(30_000);
  assert.equal(h.instances.length, attempts, "no more attempts with the same address");
  h.window.__hfLiveUrl = "fresh"; // the next normal refresh brings a new pass
  h.advance(3_100);
  assert.equal(h.instances.length, attempts + 1);
  assert.equal(h.instances.at(-1).url, "fresh");
}

// ---------- a new pass replaces the old connection ----------
{
  const h = harness();
  h.window.__hfLiveUrl = "pass-one";
  h.advance(3_100);
  h.instances[0].emit("hello");
  h.window.__hfLiveUrl = "pass-two";
  h.advance(3_100);
  assert.equal(h.instances[0].closed, true);
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[1].url, "pass-two");
  // events from the old connection are ignored
  h.instances[0].emit("hello");
  assert.equal(h.window.__hfLiveOn, false, "only the current connection counts");
  h.instances[1].emit("hello");
  assert.equal(h.window.__hfLiveOn, true);
  const before = h.refreshes.length;
  h.instances[0].emit("update");
  h.advance(3_000);
  assert.equal(h.refreshes.length, before, "an update from a closed connection is ignored");
}

// ---------- an ended auction closes the connection and never reopens it ----------
{
  const h = harness();
  h.window.__hfLiveUrl = "u1";
  h.advance(3_100);
  h.instances[0].emit("hello");
  h.window.__hfEnded = true;
  h.advance(3_100);
  assert.equal(h.instances[0].closed, true);
  assert.equal(h.window.__hfLiveOn, false);
  h.advance(60_000);
  assert.equal(h.instances.length, 1, "never reopened");
}

// ---------- a browser that can't open the connection just keeps polling ----------
{
  const h = harness({ throwing: true });
  h.window.__hfLiveUrl = "u1";
  h.advance(60_000);
  assert.ok(!h.window.__hfLiveOn, "never flagged as live");
  assert.equal(h.instances.length, 0, "no connection and no crash; the normal polling carries on");
}

console.log("Live connection (browser side): all checks passed");
