// Live check of the real-time connection on the production server: is it really streaming (not held back), and is it safe?
const https = require("https");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const BASE = "hellfire-auctions.onrender.com";

function open(urlPath, { ms = 4000, until } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = { status: 0, headers: {}, events: [], error: null };
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      try {
        req.destroy();
      } catch {
        /* closing */
      }
      resolve(out);
    };
    const req = https.get({ host: BASE, path: urlPath, headers: { Accept: "text/event-stream", Origin: "https://hellfire-auctions-dev.myshopify.com" } }, (res) => {
      out.status = res.statusCode;
      out.headers = res.headers;
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const m = /event: (\w+)/.exec(block);
          if (m) out.events.push({ name: m[1], at: Date.now() - started });
        }
        if (until && until(out)) done();
      });
      res.on("end", done);
      res.on("error", done);
    });
    req.on("error", (e) => {
      out.error = String(e);
      done();
    });
    setTimeout(done, ms);
  });
}

(async () => {
  const { liveToken } = await import(pathToFileURL(path.join(__dirname, "..", "app", "live-token.js")).href);
  const secret = fs.readFileSync(path.join(__dirname, ".secret"), "utf8").trim();
  let ok = true;
  const check = (name, pass, detail) => {
    ok = ok && pass;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  };
  const id = "live-check-" + Date.now();

  const bad = await open(`/api/stream/${id}?t=${"0".repeat(40)}`, { ms: 3000 });
  check("a wrong pass is refused", bad.status === 403, `HTTP ${bad.status}`);
  check("the refusal is readable by a browser on another site", bad.headers["access-control-allow-origin"] === "*");

  const other = await open(`/api/stream/${id}?t=${liveToken("some-other-auction", secret)}`, { ms: 3000 });
  check("another auction's pass is refused", other.status === 403, `HTTP ${other.status}`);

  const none = await open(`/api/stream/${id}`, { ms: 3000 });
  check("no pass at all is refused", none.status === 403, `HTTP ${none.status}`);

  console.log("... connecting for real (about 18 seconds, to watch the heartbeat arrive on time)");
  const good = await open(`/api/stream/${id}?t=${liveToken(id, secret)}`, { ms: 19000, until: (o) => o.events.filter((e) => e.name === "ping").length >= 1 });
  check("a good pass connects", good.status === 200, `HTTP ${good.status}${good.error ? " " + good.error : ""}`);
  check("it is an event stream", /text\/event-stream/.test(good.headers["content-type"] || ""));
  check("it carries the 'don't hold this back' instruction", /no-transform/.test(good.headers["cache-control"] || ""));
  check("it is not compressed (compression would hold events back)", !good.headers["content-encoding"], String(good.headers["content-encoding"] || "none"));
  check("browsers on other sites may connect", good.headers["access-control-allow-origin"] === "*");
  const hello = good.events.find((e) => e.name === "hello");
  check("hello arrives immediately", Boolean(hello) && hello.at < 3000, hello ? `${hello.at} ms` : "never");
  const ping = good.events.find((e) => e.name === "ping");
  check("the heartbeat arrives on time (nothing is buffered on the way)", Boolean(ping) && ping.at > 12000 && ping.at < 19000, ping ? `${(ping.at / 1000).toFixed(1)} s after connecting` : "never");

  console.log(ok ? "LIVE CONNECTION CHECK: all good" : "LIVE CONNECTION CHECK: PROBLEM");
})();
