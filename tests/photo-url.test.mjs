import assert from "node:assert/strict";
import { isPublicIp, publicHttpsUrl, urlPhotoProblem, LINK_NOT_SQUARE, LINK_UNREADABLE } from "../app/photo-url.server.js";

// ---------- which network addresses count as public ----------
for (const ok of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.0.1", "198.20.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
  assert.equal(isPublicIp(ok), true, ok);
}
for (const bad of ["10.0.0.1", "10.255.255.255", "127.0.0.1", "127.8.8.8", "0.0.0.0", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.0.5", "100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.1.1.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5", "not an ip", "", "999.1.1.1"]) {
  assert.equal(isPublicIp(bad), false, bad);
}

// ---------- which links are even attempted ----------
for (const ok of ["https://cdn.shopify.com/s/files/1/photo.jpg", "https://example.com/a.png?width=1600&v=2", "https://images.example.co.uk/x/y.webp", "https://example.com:443/a.jpg"]) {
  assert.ok(publicHttpsUrl(ok), ok);
}
for (const bad of ["http://example.com/a.jpg", "https://localhost/a.png", "https://127.0.0.1/a.png", "https://[::1]/a.png", "https://2130706433/a.png", "https://169.254.169.254/latest/meta-data", "https://user:pw@example.com/a.png", "https://example.com:8443/a.png", "https://intranet/a.png", "https://box.internal/a.png", "https://printer.local/a.png", "https://app.localhost/a.png", "javascript:alert(1)", "ftp://example.com/a.png", "", null, undefined, "not a link"]) {
  assert.equal(publicHttpsUrl(bad), null, String(bad));
}

// ---------- tiny photos with a known shape ----------
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const txt = (s) => [...s].map((c) => c.charCodeAt(0));
const png = (w, h, total = 64) => Uint8Array.from([0x89, ...txt("PNG"), 13, 10, 26, 10, ...be32(13), ...txt("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, ...new Array(Math.max(0, total - 29)).fill(0)]);

// ---------- the check itself, with the network replaced by stand-ins ----------
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
function world({ lookup, responses }) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    options: {
      lookup: async (host) => (lookup ? lookup(host) : PUBLIC),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return next();
      },
    },
  };
}
const image = (bytes, { status = 200, type = "image/png" } = {}) => () => new Response(bytes, { status, headers: { "content-type": type } });
const redirect = (to, status = 302) => () => new Response(null, { status, headers: to ? { location: to } : {} });

let w = world({ responses: [image(png(1600, 1600))] });
assert.equal(await urlPhotoProblem("https://cdn.example.com/a.png", w.options), null, "a square photo passes");
assert.equal(w.calls.length, 1);
assert.match(w.calls[0].init.headers.Range, /^bytes=0-262143$/, "only the start of the file is requested");
assert.equal(w.calls[0].init.redirect, "manual", "redirects are never followed blindly");
assert.ok(w.calls[0].init.signal, "there is a time limit");

assert.equal(await urlPhotoProblem("https://cdn.example.com/a.png", world({ responses: [image(png(1600, 1200))] }).options), LINK_NOT_SQUARE, "a wide photo is refused");
assert.equal(await urlPhotoProblem("https://cdn.example.com/a.png", world({ responses: [image(png(1000, 1005))] }).options), null, "within 1% counts as square");
assert.equal(await urlPhotoProblem("https://cdn.example.com/a.png", world({ responses: [image(png(800, 800), { type: "application/octet-stream" })] }).options), null, "servers that call every file octet-stream are fine");
assert.equal(await urlPhotoProblem("https://cdn.example.com/a.png", world({ responses: [image(png(800, 800), { status: 206 })] }).options), null, "a partial answer is what was asked for");

// things that aren't photos, or can't be fetched
assert.equal(await urlPhotoProblem("https://cdn.example.com/a", world({ responses: [image(png(800, 800), { type: "text/html" })] }).options), LINK_UNREADABLE);
assert.equal(await urlPhotoProblem("https://cdn.example.com/a", world({ responses: [image(Uint8Array.from(txt("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>")), { type: "image/svg+xml" })] }).options), LINK_UNREADABLE, "an SVG's shape can't be read, so it is refused");
assert.equal(await urlPhotoProblem("https://cdn.example.com/a", world({ responses: [image(png(800, 800), { status: 404 })] }).options), LINK_UNREADABLE);
assert.equal(await urlPhotoProblem("https://cdn.example.com/a", world({ responses: [image(Uint8Array.from(txt("this is not a photo at all, just words")))] }).options), LINK_UNREADABLE);
assert.equal(await urlPhotoProblem("https://cdn.example.com/a", world({ responses: [new Error("timed out")] }).options), LINK_UNREADABLE, "if it can't be verified it is refused");

// a huge file is never downloaded in full
const huge = png(1200, 1200, 2_000_000);
assert.equal(await urlPhotoProblem("https://cdn.example.com/huge.png", world({ responses: [image(huge)] }).options), null);

// private and internal addresses are never contacted
w = world({ lookup: async () => [{ address: "10.0.0.5", family: 4 }], responses: [image(png(800, 800))] });
assert.equal(await urlPhotoProblem("https://sneaky.example.com/a.png", w.options), LINK_UNREADABLE);
assert.equal(w.calls.length, 0, "no request is sent to a private address");
w = world({ lookup: async () => [{ address: "93.184.216.34" }, { address: "169.254.169.254" }], responses: [image(png(800, 800))] });
assert.equal(await urlPhotoProblem("https://sneaky.example.com/a.png", w.options), LINK_UNREADABLE, "one private address among the answers is enough to refuse");
assert.equal(w.calls.length, 0);
w = world({ lookup: async () => [], responses: [image(png(800, 800))] });
assert.equal(await urlPhotoProblem("https://nothing.example.com/a.png", w.options), LINK_UNREADABLE, "a name that doesn't resolve");
for (const bad of ["http://cdn.example.com/a.png", "https://localhost/a.png", "https://127.0.0.1/a.png", "", "nonsense"]) {
  w = world({ responses: [image(png(800, 800))] });
  assert.equal(await urlPhotoProblem(bad, w.options), LINK_UNREADABLE, bad);
  assert.equal(w.calls.length, 0, `${bad}: nothing is fetched`);
}

// redirects are followed a few times, and every step is checked again
w = world({ responses: [redirect("https://cdn2.example.com/real.png"), image(png(900, 900))] });
assert.equal(await urlPhotoProblem("https://short.example.com/x", w.options), null);
assert.equal(w.calls.length, 2);
assert.equal(w.calls[1].url, "https://cdn2.example.com/real.png");
w = world({ responses: [redirect("/other/path.png", 301), image(png(900, 900))] });
assert.equal(await urlPhotoProblem("https://short.example.com/x", w.options), null, "a relative redirect works");
assert.equal(w.calls[1].url, "https://short.example.com/other/path.png");
w = world({ lookup: async (host) => (host === "internal.example.com" ? [{ address: "10.1.1.1" }] : PUBLIC), responses: [redirect("https://internal.example.com/a.png"), image(png(800, 800))] });
assert.equal(await urlPhotoProblem("https://short.example.com/x", w.options), LINK_UNREADABLE, "a redirect into a private network is refused");
assert.equal(w.calls.length, 1, "...and never contacted");
w = world({ responses: [redirect("http://cdn.example.com/a.png"), image(png(800, 800))] });
assert.equal(await urlPhotoProblem("https://short.example.com/x", w.options), LINK_UNREADABLE, "a redirect to plain http is refused");
w = world({ responses: [redirect("https://127.0.0.1/a.png"), image(png(800, 800))] });
assert.equal(await urlPhotoProblem("https://short.example.com/x", w.options), LINK_UNREADABLE, "a redirect to an IP address is refused");
w = world({ responses: [redirect(null), image(png(800, 800))] });
assert.equal(await urlPhotoProblem("https://short.example.com/x", w.options), LINK_UNREADABLE, "a redirect with nowhere to go");
w = world({ responses: [redirect("https://loop.example.com/again")] });
assert.equal(await urlPhotoProblem("https://loop.example.com/start", w.options), LINK_UNREADABLE, "endless redirects are cut off");
assert.equal(w.calls.length, 4, "the first request plus three redirects, then it stops");

console.log("Photo link check: all checks passed");
