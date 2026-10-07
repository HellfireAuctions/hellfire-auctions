/* Hellfire Auctions: the "Live Auctions" button. A small floating button that opens a list of the store's running
   auctions (or says there are none). Added by the theme app embed, so it shows the moment the embed is switched on. */
(function () {
  "use strict";
  if (window.__hellfireHubInit) return;
  window.__hellfireHubInit = true;
  var cfgEl = document.getElementById("hellfire-hub-config");
  if (!cfgEl) return;
  var cfg;
  try { cfg = JSON.parse(cfgEl.textContent); } catch (e) { return; }
  var path = location.pathname;
  if (path.indexOf("/apps/hellfire-auctions/") !== -1 || /^\/cart(\/|$)/.test(path)) return;

  /*I18N:hub*/var TR = {"es":{"Live Auctions":"Subastas en vivo","No live auctions right now.":"No hay subastas en vivo ahora mismo.","View all auctions":"Ver todas las subastas","Close":"Cerrar","Current bid":"Puja actual","Starting bid":"Puja inicial","1 bid":"1 puja","{n} bids":"{n} pujas","No bids yet":"Aún sin pujas"},"fr":{"Live Auctions":"Enchères en cours","No live auctions right now.":"Aucune enchère en cours pour le moment.","View all auctions":"Voir toutes les enchères","Close":"Fermer","Current bid":"Enchère actuelle","Starting bid":"Mise de départ","1 bid":"1 enchère","{n} bids":"{n} enchères","No bids yet":"Pas encore d’enchères"},"de":{"Live Auctions":"Live-Auktionen","No live auctions right now.":"Zurzeit gibt es keine Live-Auktionen.","View all auctions":"Alle Auktionen ansehen","Close":"Schließen","Current bid":"Aktuelles Gebot","Starting bid":"Startgebot","1 bid":"1 Gebot","{n} bids":"{n} Gebote","No bids yet":"Noch keine Gebote"},"pt":{"Live Auctions":"Leilões ao vivo","No live auctions right now.":"Nenhum leilão ao vivo no momento.","View all auctions":"Ver todos os leilões","Close":"Fechar","Current bid":"Lance atual","Starting bid":"Lance inicial","1 bid":"1 lance","{n} bids":"{n} lances","No bids yet":"Ainda sem lances"},"it":{"Live Auctions":"Aste in corso","No live auctions right now.":"Nessuna asta in corso al momento.","View all auctions":"Vedi tutte le aste","Close":"Chiudi","Current bid":"Offerta attuale","Starting bid":"Offerta iniziale","1 bid":"1 offerta","{n} bids":"{n} offerte","No bids yet":"Ancora nessuna offerta"},"nl":{"Live Auctions":"Live veilingen","No live auctions right now.":"Op dit moment zijn er geen live veilingen.","View all auctions":"Bekijk alle veilingen","Close":"Sluiten","Current bid":"Huidig bod","Starting bid":"Startbod","1 bid":"1 bod","{n} bids":"{n} biedingen","No bids yet":"Nog geen biedingen"}};/*END*/
  var LANG = String(cfg.locale || (window.Shopify && window.Shopify.locale) || document.documentElement.getAttribute("lang") || "en").slice(0, 2).toLowerCase();
  function T(s) { var D = TR[LANG]; return D && Object.prototype.hasOwnProperty.call(D, s) ? D[s] : s; }

  function money(v, cur) {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD" }).format(Number(v || 0)); }
    catch (e) { return "$" + Number(v || 0).toFixed(2); }
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function left(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    if (d > 0) return d + "d " + h + "h " + pad(m) + "m";
    if (h > 0) return h + "h " + pad(m) + "m " + pad(x) + "s";
    return m + "m " + pad(x) + "s";
  }
  function node(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // readable text on whatever colour the merchant picks
  function textOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return "#ffffff";
    var n = parseInt(m[1], 16);
    var lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#111111" : "#ffffff";
  }

  var KEY = "hf_hub_v1";
  var label = (cfg.label && String(cfg.label).trim()) || T("Live Auctions");
  var currency = cfg.currency || "USD";
  var items = [];
  var offset = 0;
  var isOpen = false;

  var root = node("div", "hf-hub hf-hub--" + (cfg.position === "left" ? "left" : "right"));
  root.setAttribute("data-hellfire-no-badges", "");
  root.style.setProperty("--hf-hub-bg", /^#[0-9a-f]{6}$/i.test(cfg.color || "") ? cfg.color : "#1a1a1a");
  root.style.setProperty("--hf-hub-fg", textOn(cfg.color));
  root.style.setProperty("--hf-hub-offset", (Math.max(8, Math.min(160, Number(cfg.offset) || 20))) + "px");

  var panel = node("div", "hf-hub__panel");
  panel.id = "hf-hub-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", label);
  panel.tabIndex = -1;
  panel.hidden = true;

  var head = node("div", "hf-hub__head");
  head.appendChild(node("strong", "hf-hub__title", label));
  var close = node("button", "hf-hub__close", "\u00d7");
  close.type = "button";
  close.setAttribute("aria-label", T("Close"));
  head.appendChild(close);
  panel.appendChild(head);

  var list = node("div", "hf-hub__list");
  list.setAttribute("aria-live", "polite");
  panel.appendChild(list);
  if (cfg.designMode) panel.appendChild(node("p", "hf-hub__note", "Preview in the theme editor. Shoppers see this button on your storefront."));
  var all = node("a", "hf-hub__all", T("View all auctions"));
  all.href = typeof cfg.collection === "string" && cfg.collection.charAt(0) === "/" ? cfg.collection : "/collections/live-auctions";
  panel.appendChild(all);

  var pill = node("button", "hf-hub__pill");
  pill.type = "button";
  pill.setAttribute("aria-expanded", "false");
  pill.setAttribute("aria-controls", "hf-hub-panel");
  var dot = node("span", "hf-hub__dot");
  dot.setAttribute("aria-hidden", "true");
  var pillText = node("span", "hf-hub__label", label);
  var count = node("span", "hf-hub__count");
  count.hidden = true;
  pill.appendChild(dot);
  pill.appendChild(pillText);
  pill.appendChild(count);

  root.appendChild(panel);
  root.appendChild(pill);

  function render() {
    var now = Date.now() + offset;
    var live = items.filter(function (a) { return Date.parse(a.endsAt) > now; });
    count.hidden = !live.length;
    count.textContent = live.length ? String(live.length) : "";
    pill.setAttribute("aria-label", label + (live.length ? ": " + live.length : ""));
    root.hidden = !live.length && cfg.hideEmpty === true && !cfg.designMode;
    list.innerHTML = "";
    if (!live.length) {
      list.appendChild(node("p", "hf-hub__empty", T("No live auctions right now.")));
      return;
    }
    live.slice(0, 6).forEach(function (a) {
      var link = node("a", "hf-hub__item");
      link.href = typeof a.url === "string" && a.url.charAt(0) === "/" ? a.url : "#";
      var media = node("span", "hf-hub__media");
      if (typeof a.image === "string" && a.image.indexOf("https://") === 0) {
        var img = document.createElement("img");
        img.src = a.image; img.alt = ""; img.loading = "lazy";
        media.appendChild(img);
      }
      link.appendChild(media);
      var info = node("span", "hf-hub__info");
      info.appendChild(node("span", "hf-hub__name", a.title));
      var bid = node("span", "hf-hub__bid", (a.bidCount ? T("Current bid") : T("Starting bid")) + " ");
      bid.appendChild(node("strong", "", money(a.currentBid, currency)));
      info.appendChild(bid);
      var meta = node("span", "hf-hub__meta");
      var time = node("span", "hf-hub__time", left(Date.parse(a.endsAt) - now));
      time.setAttribute("data-end", a.endsAt);
      meta.appendChild(time);
      meta.appendChild(node("span", "", a.bidCount === 1 ? T("1 bid") : a.bidCount ? T("{n} bids").replace("{n}", a.bidCount) : T("No bids yet")));
      info.appendChild(meta);
      link.appendChild(info);
      list.appendChild(link);
    });
  }

  function tick() {
    if (!isOpen) return;
    var now = Date.now() + offset, times = list.querySelectorAll(".hf-hub__time"), expired = false;
    for (var i = 0; i < times.length; i++) {
      var remaining = Date.parse(times[i].getAttribute("data-end")) - now;
      if (remaining <= 0) { expired = true; break; }
      times[i].textContent = left(remaining);
    }
    if (expired) render();
  }

  function use(d) {
    if (!d || !d.auctions) return;
    offset = d.now ? Date.parse(d.now) - Date.now() : 0;
    if (d.currency) currency = d.currency;
    items = d.auctions;
    render();
  }
  function load() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (saved && Date.now() - saved.t < 20000 && saved.e === cfg.endpoint) { use(saved.d); return; }
    } catch (e) {}
    fetch(cfg.endpoint + (cfg.endpoint.indexOf("?") > -1 ? "&" : "?") + "limit=6", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        try { sessionStorage.setItem(KEY, JSON.stringify({ t: Date.now(), e: cfg.endpoint, d: d })); } catch (e) {}
        use(d);
      })
      .catch(function () {});
  }

  function openPanel() {
    isOpen = true;
    panel.hidden = false;
    pill.setAttribute("aria-expanded", "true");
    panel.focus();
    tick();
  }
  function closePanel(returnFocus) {
    isOpen = false;
    panel.hidden = true;
    pill.setAttribute("aria-expanded", "false");
    if (returnFocus) pill.focus();
  }
  pill.addEventListener("click", function () { if (isOpen) closePanel(true); else openPanel(); });
  close.addEventListener("click", function () { closePanel(true); });
  document.addEventListener("keydown", function (e) { if (isOpen && (e.key === "Escape" || e.key === "Esc")) closePanel(true); });
  document.addEventListener("click", function (e) { if (isOpen && !root.contains(e.target)) closePanel(false); });

  function boot() {
    if (document.getElementById("hf-hub-root")) return;
    root.id = "hf-hub-root";
    document.body.appendChild(root);
    render();
    load();
    setInterval(function () { if (!document.hidden) load(); }, 30000);
    setInterval(function () { if (!document.hidden) tick(); }, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
