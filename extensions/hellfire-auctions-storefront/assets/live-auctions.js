(function () {
  if (window.__hellfireLiveInit) return;
  window.__hellfireLiveInit = true;

  var REFRESH_MS = 20000;
  var LANG = String((window.Shopify && window.Shopify.locale) || document.documentElement.getAttribute("lang") || "en").slice(0, 2).toLowerCase();
  /*I18N:block*/var TR = {"es":{"Test":"Prueba","Ending soon":"Termina pronto","Current bid":"Puja actual","Starting bid":"Puja inicial","1 bid":"1 puja","{n} bids":"{n} pujas","No bids yet":"Aún sin pujas"},"fr":{"Test":"Test","Ending soon":"Se termine bientôt","Current bid":"Enchère actuelle","Starting bid":"Mise de départ","1 bid":"1 enchère","{n} bids":"{n} enchères","No bids yet":"Pas encore d’enchères"},"de":{"Test":"Test","Ending soon":"Endet bald","Current bid":"Aktuelles Gebot","Starting bid":"Startgebot","1 bid":"1 Gebot","{n} bids":"{n} Gebote","No bids yet":"Noch keine Gebote"},"pt":{"Test":"Teste","Ending soon":"Termina em breve","Current bid":"Lance atual","Starting bid":"Lance inicial","1 bid":"1 lance","{n} bids":"{n} lances","No bids yet":"Ainda sem lances"},"it":{"Test":"Prova","Ending soon":"Termina presto","Current bid":"Offerta attuale","Starting bid":"Offerta iniziale","1 bid":"1 offerta","{n} bids":"{n} offerte","No bids yet":"Ancora nessuna offerta"},"nl":{"Test":"Test","Ending soon":"Eindigt binnenkort","Current bid":"Huidig bod","Starting bid":"Startbod","1 bid":"1 bod","{n} bids":"{n} biedingen","No bids yet":"Nog geen biedingen"}};/*END*/
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

  function init(root) {
    if (root.getAttribute("data-ready")) return;
    root.setAttribute("data-ready", "1");
    root.style.display = "none"; // stays hidden until there is something to show
    var grid = root.querySelector(".hellfire-live__grid");
    if (!grid) return;
    var endpoint = root.getAttribute("data-endpoint");
    var max = parseInt(root.getAttribute("data-max"), 10) || 8;
    var hideEmpty = root.getAttribute("data-hide-empty") !== "false";
    var emptyMessage = root.getAttribute("data-empty-message") || "";
    var currency = root.getAttribute("data-currency") || "USD";
    var offset = 0;
    var items = [];

    function tick() {
      var now = Date.now() + offset, expired = false;
      var times = grid.querySelectorAll(".hellfire-live__time");
      for (var i = 0; i < times.length; i++) {
        var remaining = Date.parse(times[i].getAttribute("data-end")) - now;
        if (remaining <= 0) { expired = true; break; }
        times[i].textContent = left(remaining);
      }
      if (expired) render();
    }

    function render() {
      var now = Date.now() + offset;
      var live = items.filter(function (a) { return Date.parse(a.endsAt) > now; });
      grid.innerHTML = "";
      if (!live.length) {
        if (hideEmpty) { root.style.display = "none"; return; }
        root.style.display = "";
        if (emptyMessage) grid.appendChild(node("p", "hellfire-live__empty", emptyMessage));
        return;
      }
      root.style.display = "";
      live.forEach(function (a) {
        var card = node("a", "hellfire-live__card");
        card.href = a.url;
        if (Date.parse(a.endsAt) - now < 3600000) card.className += " is-soon";
        var media = node("div", "hellfire-live__media");
        if (a.image) {
          var img = document.createElement("img");
          img.src = a.image; img.alt = a.title || ""; img.loading = "lazy";
          media.appendChild(img);
        }
        card.appendChild(media);
        if (a.isTest) card.appendChild(node("span", "hellfire-live__chip hellfire-live__chip--test", T("Test")));
        else if (Date.parse(a.endsAt) - now < 3600000) card.appendChild(node("span", "hellfire-live__chip", T("Ending soon")));
        var body = node("div", "hellfire-live__body");
        body.appendChild(node("div", "hellfire-live__title", a.title));
        var bid = node("div", "hellfire-live__bid");
        bid.appendChild(document.createTextNode((a.bidCount ? T("Current bid") : T("Starting bid")) + " "));
        bid.appendChild(node("strong", "", money(a.currentBid, currency)));
        body.appendChild(bid);
        var meta = node("div", "hellfire-live__meta");
        var time = node("span", "hellfire-live__time", left(Date.parse(a.endsAt) - now));
        time.setAttribute("data-end", a.endsAt);
        meta.appendChild(time);
        meta.appendChild(node("span", "", a.bidCount === 1 ? T("1 bid") : a.bidCount ? T("{n} bids").replace("{n}", a.bidCount) : T("No bids yet")));
        body.appendChild(meta);
        card.appendChild(body);
        grid.appendChild(card);
      });
    }

    function load() {
      var url = endpoint + (endpoint.indexOf("?") > -1 ? "&" : "?") + "limit=" + max;
      fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.auctions) return;
          offset = d.now ? Date.parse(d.now) - Date.now() : 0;
          if (d.currency) currency = d.currency;
          items = d.auctions;
          render();
        })
        .catch(function () {});
    }

    load();
    setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
    setInterval(function () { if (!document.hidden) tick(); }, 1000);
  }

  function boot() {
    var roots = document.querySelectorAll(".hellfire-live");
    for (var i = 0; i < roots.length; i++) init(roots[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  // Theme editor: blocks are added and re-rendered live.
  document.addEventListener("shopify:section:load", boot);
  document.addEventListener("shopify:block:select", boot);
})();
