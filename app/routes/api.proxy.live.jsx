import prisma from "../db.server";
import { proxyAuth } from "../proxy-auth.server";
import { memo } from "../memo.server";
import { liveStreamUrl, liveHasRoom } from "../live-stream.server";
import { roomView } from "../action-sale";
import { embedFor } from "../video-embed";
import { streamIsLive } from "../go-live";
import { shopCurrency } from "../currency.server";

// The shopper's room for a Live Drops, at /apps/hellfire-auctions/live?sale=<id>. A host shows items on video
// and sells them at a set price; the first people to tap CLAIM get them. Returned as Liquid so Shopify draws it inside
// the store's own theme. The page is a thin shell: it fetches the room's state as data (add &format=json) and redraws.

const esc = (value) =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("{", "&#123;").replaceAll("}", "&#125;");
const liquid = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/liquid" } });

async function loadState(shop, saleId, customerId) {
  if (!shop || !saleId) return null;
  const sale = await memo("action:" + saleId, 700, () => prisma.actionSale.findFirst({ where: { id: saleId }, include: { drops: true } }));
  if (!sale || sale.shop !== shop) return null;
  const myClaims = customerId ? await prisma.actionClaim.findMany({ where: { saleId, shop, customerId }, select: { dropId: true, quantity: true } }) : [];
  const embed = embedFor(sale.videoUrl);
  return { ...roomView({ sale, drops: sale.drops, myClaims }), saleId: sale.id, loggedIn: Boolean(customerId), video: embed ? embed.src : null, stream: streamIsLive(sale) ? { playUrl: sale.streamPlayUrl } : null };
}

function pageHtml(state, cfg) {
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<div data-hellfire-no-badges style="max-width:760px;margin:0 auto;padding:20px 16px 60px">
  <noscript><p>Please turn on JavaScript to join the show.</p></noscript>
  <div id="hf-head"></div>
  <div id="hf-video"></div>
  <div id="hf-video-live"></div>
  <div id="hf-show"><p>Loading ${esc(state.title)}...</p></div>
</div>
<script>
(function () {
  var cfg = ${json};
  var root = document.getElementById("hf-show");
  var state = null, message = "", busy = false, timer = null, spread = 400, confirming = null, confirmTimer = null;
  function money(n) { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cfg.currency }).format(Number(n)); } catch (e) { return "$" + Number(n).toFixed(2); } }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  var BORDER = "1px solid rgba(127,127,127,.35)";
  var head = document.getElementById("hf-head");
  if (cfg.video) {
    var vbox = el("div", "position:relative;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;margin-bottom:16px");
    var frame = document.createElement("iframe");
    frame.src = cfg.video.replace("{parent}", encodeURIComponent(location.hostname));
    frame.allow = "autoplay; fullscreen; picture-in-picture";
    frame.allowFullscreen = true;
    frame.title = "Live video";
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
    vbox.appendChild(frame);
    document.getElementById("hf-video").appendChild(vbox); // built once, so it never restarts when the room redraws
  }
  function post(intent, fields) {
    var body = new URLSearchParams();
    body.set("intent", intent);
    body.set("sale", cfg.sale);
    Object.keys(fields || {}).forEach(function (k) { body.set(k, fields[k]); });
    return fetch(cfg.claimUrl, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
  }
  function cancelConfirm() {
    confirming = null;
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    render();
  }
  // the first tap only asks; nothing is claimed until the shopper says yes (and it cancels itself after 8 seconds)
  function askFirst() {
    if (!state || !state.open) return;
    if (!state.loggedIn) { location.href = cfg.login; return; }
    confirming = state.open.id; message = "";
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(cancelConfirm, 8000);
    render();
  }
  function claim(dropId) {
    var id = typeof dropId === "string" ? dropId : (state && state.open ? state.open.id : "");
    if (!id) return;
    if (!state || !state.loggedIn) { location.href = cfg.login; return; }
    if (busy) return;
    confirming = null;
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    busy = true; message = ""; render();
    post("claim", { drop: id }).then(function (r) {
      busy = false;
      if (r.status === 401) { location.href = cfg.login; return; }
      var j = r.json || {};
      message = j.ok ? (j.soldOut ? "You got it! That was the last one." : "You got it! " + j.remaining + " left.") : (j.message || "Something went wrong. Try again.");
      load();
    }).catch(function () { busy = false; message = "Connection problem. Try again."; render(); });
  }
  function checkout() {
    if (busy) return;
    busy = true; message = ""; render();
    post("checkout", {}).then(function (r) {
      busy = false;
      var j = r.json || {};
      if (j.ok && j.url) { location.href = j.url; return; }
      message = j.message || "We couldn't open checkout. Try again.";
      render();
    }).catch(function () { busy = false; message = "Connection problem. Try again."; render(); });
  }
  function bigButton(label, handler, disabled) {
    var b = el("button", "display:block;width:100%;min-height:64px;margin:14px 0 6px;border:0;border-radius:14px;background:#d72c0d;color:#fff;font:inherit;font-size:22px;font-weight:800;cursor:pointer;opacity:" + (disabled ? ".6" : "1"), label);
    b.type = "button"; b.disabled = Boolean(disabled); b.addEventListener("click", handler);
    return b;
  }
  function row(item, text) {
    var r = el("div", "display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:" + BORDER);
    if (item.imageUrl) { var img = document.createElement("img"); img.src = item.imageUrl; img.alt = ""; img.loading = "lazy"; img.style.cssText = "width:56px;height:56px;aspect-ratio:1/1;object-fit:cover;border-radius:8px;flex:none"; r.appendChild(img); }
    var box = el("div"); box.appendChild(el("div", "font-weight:600", item.title)); box.appendChild(el("div", "font-size:14px;opacity:.8", text)); r.appendChild(box);
    return r;
  }
  function render() {
    root.textContent = "";
    var s = state;
    if (!s) { root.appendChild(el("p", "", "Loading...")); return; }
    var chip = { open: "LIVE NOW", between: "NEXT ITEM COMING UP", before: "STARTING SOON", ended: "THE SHOW HAS ENDED" }[s.phase];
    head.textContent = "";
    head.appendChild(el("div", "font-size:13px;font-weight:700;letter-spacing:.04em;" + (s.phase === "open" ? "color:#d72c0d" : "opacity:.7"), chip));
    head.appendChild(el("h1", "margin:2px 0 14px", s.title));
    var card = el("div", "border:" + BORDER + ";border-radius:14px;padding:16px;margin-bottom:16px");
    if (s.open) {
      var o = s.open;
      if (o.imageUrl) { var pic = document.createElement("img"); pic.src = o.imageUrl; pic.alt = ""; pic.style.cssText = "display:block;width:100%;max-width:360px;aspect-ratio:1/1;object-fit:cover;border-radius:12px;margin:0 auto 12px"; card.appendChild(pic); }
      card.appendChild(el("div", "font-size:20px;font-weight:700", o.title));
      card.appendChild(el("div", "font-size:34px;font-weight:800;margin:4px 0", money(o.price)));
      card.appendChild(el("div", "font-size:16px", o.remaining === 1 ? "Last one!" : o.remaining + " of " + o.quantity + " left" + (o.perPerson > 1 ? " (limit " + o.perPerson + " each)" : "")));
      var capped = o.mine >= o.perPerson;
      if (confirming === o.id && s.loggedIn && !capped) {
        var ask = el("div", "margin:14px 0 6px;padding:14px;border:2px solid #d72c0d;border-radius:14px");
        ask.appendChild(el("div", "font-size:18px;font-weight:800;margin-bottom:10px", "Claim " + o.title + " for " + money(o.price) + "?"));
        var yes = el("button", "display:block;width:100%;min-height:60px;margin-bottom:8px;border:0;border-radius:12px;background:#d72c0d;color:#fff;font:inherit;font-size:20px;font-weight:800;cursor:pointer", "Yes, claim it");
        yes.type = "button"; yes.disabled = busy;
        yes.addEventListener("click", function () { claim(o.id); }); // always the item that was shown, even if the host has moved on
        var no = el("button", "display:block;width:100%;min-height:48px;border:1px solid rgba(127,127,127,.6);border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:16px;font-weight:700;cursor:pointer", "Cancel");
        no.type = "button"; no.addEventListener("click", cancelConfirm);
        ask.appendChild(yes); ask.appendChild(no); card.appendChild(ask);
      } else {
        card.appendChild(bigButton(!s.loggedIn ? "Log in to claim" : capped ? "You have " + o.mine : "CLAIM " + money(o.price), askFirst, busy || capped));
      }
      if (o.mine) card.appendChild(el("div", "font-weight:600", "You have " + o.mine + " of these."));
    } else {
      card.appendChild(el("p", "font-size:18px;margin:0", { between: "The next item is coming up. Stay on this page: it appears here the moment it opens.", before: "The show hasn't started yet. Stay on this page: the first item appears here the moment it opens.", ended: "Thank you for joining! The show has ended. Anything you claimed is combined into one invoice, emailed to you within about 30 minutes (or pay now with Checkout)." }[s.phase]));
    }
    root.appendChild(card);
    var live = el("div", "min-height:24px;font-weight:600;margin-bottom:10px", message); live.setAttribute("aria-live", "polite"); root.appendChild(live);
    if (s.mine.length) {
      var cart = el("div", "border:2px solid #008060;border-radius:14px;padding:14px 16px;margin-bottom:16px");
      cart.appendChild(el("div", "font-weight:800;margin-bottom:6px", "Your claims"));
      s.mine.forEach(function (m) { cart.appendChild(el("div", "", m.quantity + " x " + m.title + " - " + money(m.price * m.quantity))); });
      cart.appendChild(el("div", "font-weight:800;margin-top:6px", "Total " + money(s.mineTotal)));
      cart.appendChild(el("div", "font-size:13px;opacity:.8;margin-top:4px", s.phase === "ended" ? "Your combined invoice is emailed within about 30 minutes of the show ending. You can also pay now." : "Your combined invoice is emailed about 30 minutes after the show ends, or you can pay now."));
      var pay = el("button", "display:block;width:100%;min-height:52px;margin-top:10px;border:0;border-radius:12px;background:#008060;color:#fff;font:inherit;font-size:18px;font-weight:800;cursor:pointer", "Checkout");
      pay.type = "button"; pay.disabled = busy; pay.addEventListener("click", checkout); cart.appendChild(pay);
      root.appendChild(cart);
    }
    if (s.upcoming.length) { root.appendChild(el("h2", "margin:22px 0 4px;font-size:18px", "Coming up")); s.upcoming.forEach(function (u) { root.appendChild(row(u, money(u.price) + (u.quantity > 1 ? ", " + u.quantity + " available" : ", 1 available"))); }); }
    if (s.results.length) { root.appendChild(el("h2", "margin:22px 0 4px;font-size:18px", "Earlier in the show")); s.results.forEach(function (r) { root.appendChild(row({ title: r.title }, r.soldOut ? "Sold out" : r.claimed + " of " + r.quantity + " claimed")); }); }
  }
  var liveBox = document.getElementById("hf-video-live");
  var live = { pc: null, url: "", video: null, wrap: null, timer: null };
  function stopLive() {
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
    if (live.pc) { try { live.pc.close(); } catch (e) { /* already closed */ } live.pc = null; }
    live.url = "";
    liveBox.textContent = "";
  }
  function retryLive(pc, ms) {
    if (live.timer) clearTimeout(live.timer);
    live.timer = setTimeout(function () { if (state && state.stream && live.pc === pc) connectLive(state.stream.playUrl); }, ms);
  }
  function connectLive(url) {
    if (live.pc) { try { live.pc.close(); } catch (e) { /* already closed */ } }
    live.url = url;
    if (!live.video) {
      live.wrap = el("div", "position:relative;width:100%;max-width:640px;margin:0 auto 16px;aspect-ratio:1/1;min-height:min(600px,100vw);background:#000;border-radius:12px;overflow:hidden");
      var v = document.createElement("video");
      v.autoplay = true; v.muted = true; v.playsInline = true; v.controls = true;
      v.setAttribute("playsinline", "");
      v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000";
      live.wrap.appendChild(v);
      live.video = v;
      var BTN = "position:absolute;z-index:2;padding:8px 12px;border:0;border-radius:8px;background:rgba(0,0,0,.7);color:#fff;font:inherit;font-weight:700;cursor:pointer";
      var full = el("button", BTN + ";top:10px;right:10px", "Full screen");
      full.type = "button";
      full.addEventListener("click", function () {
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else if (live.wrap.requestFullscreen) { live.wrap.requestFullscreen(); }
        else if (v.webkitEnterFullscreen) { v.webkitEnterFullscreen(); }
      });
      var sound = el("button", BTN + ";top:10px;left:10px", "Tap for sound");
      sound.type = "button";
      sound.addEventListener("click", function () { v.muted = false; sound.style.display = "none"; });
      live.wrap.appendChild(full);
      live.wrap.appendChild(sound);
    }
    liveBox.textContent = "";
    liveBox.appendChild(live.wrap);
    var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
    live.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    var bag = new MediaStream();
    pc.ontrack = function (e) {
      bag.addTrack(e.track);
      if (live.video.srcObject !== bag) live.video.srcObject = bag;
      var p = live.video.play(); if (p && p.catch) p.catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      if ((pc.connectionState === "failed" || pc.connectionState === "disconnected") && live.pc === pc) retryLive(pc, 2000);
    };
    pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).then(function () {
      return new Promise(function (resolve) {
        if (pc.iceGatheringState === "complete") return resolve();
        var t = setTimeout(resolve, 2500);
        pc.addEventListener("icegatheringstatechange", function () { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
      });
    }).then(function () { return fetch(url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription.sdp }); })
      .then(function (r) { if (!r.ok) throw new Error("play " + r.status); return r.text(); })
      .then(function (answer) { return pc.setRemoteDescription({ type: "answer", sdp: answer }); })
      .catch(function () { if (live.pc === pc) retryLive(pc, 3000); });
  }
  function syncLive() {
    var s = state && state.stream;
    var embed = document.getElementById("hf-video");
    if (embed) embed.style.display = s ? "none" : "";
    if (!s || !window.RTCPeerConnection) { if (live.url) stopLive(); return; }
    var dead = !live.pc || live.pc.connectionState === "closed" || live.pc.connectionState === "failed";
    if (live.url !== s.playUrl || dead) connectLive(s.playUrl);
  }
  function load() {
    fetch(cfg.url, { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) { if (j && j.version) { state = j; if (confirming && !(j.open && j.open.id === confirming)) confirming = null; render(); syncLive(); } }).catch(function () {});
  }
  function scheduleLoad() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; load(); }, Math.random() * spread);
  }
  load();
  setInterval(function () { if (!document.hidden) load(); }, 5000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  if (cfg.stream) {
    try {
      var es = new EventSource(cfg.stream);
      es.addEventListener("update", function (e) {
        try { var d = JSON.parse(e.data); spread = Math.min(5000, Math.max(350, (d.n || 0) * 8)); } catch (x) { /* keep the last spread */ }
        scheduleLoad();
      });
    } catch (e) { /* the 5-second refresh still keeps the room current */ }
  }
})();
</script>`;
}

export const loader = async ({ request }) => {
  const { session } = await proxyAuth(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const saleId = url.searchParams.get("sale") || "";
  const customerId = url.searchParams.get("logged_in_customer_id") || null;
  const state = await loadState(shop, saleId, customerId);

  if (url.searchParams.get("format") === "json") {
    return state ? Response.json(state, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Show not found." }, { status: 404 });
  }
  if (!state) {
    return liquid(`<div data-hellfire-no-badges style="max-width:700px;margin:0 auto;padding:40px 16px"><h1>Show not found</h1><p>This link isn&rsquo;t valid any more. Check the link you were given.</p></div>`, 404);
  }
  const currency = await shopCurrency(shop);
  const base = process.env.SHOPIFY_APP_URL || url.origin;
  const cfg = {
    sale: state.saleId,
    url: `/apps/hellfire-auctions/live?sale=${state.saleId}&format=json`,
    claimUrl: "/apps/hellfire-auctions/live-claim",
    login: `/account/login?return_url=${encodeURIComponent(`/apps/hellfire-auctions/live?sale=${state.saleId}`)}`,
    stream: liveHasRoom() ? liveStreamUrl("sale-" + state.saleId, base) || "" : "",
    video: state.video || "",
    currency: typeof currency === "string" ? currency : currency?.code || "USD",
  };
  return liquid(pageHtml(state, cfg));
};
