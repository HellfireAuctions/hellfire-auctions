/* Hellfire Auctions - product card badges.
 * Separate from the main auction runtime on purpose: if this file fails, nothing else is affected.
 * Rules: only ADD a badge to cards that link to an auction product. Never hide, move or restyle theme elements.
 */
(() => {
  "use strict";
  if (window.__hellfireAuctionCards) return;
  window.__hellfireAuctionCards = true;

  let config = {};
  try {
    config = JSON.parse(document.getElementById("hellfire-auction-cards-config")?.textContent || "{}");
  } catch (_) {}

  const ENDPOINT = config.endpoint || "/apps/hellfire-auctions/auction-cards";
  const REFRESH_MS = 10_000;
  const BADGE_ATTR = "data-hellfire-card-badge";
  const STOP_TAGS = new Set(["BODY", "MAIN", "SECTION", "HEADER", "FOOTER", "NAV", "UL", "OL", "DIALOG"]);

  const auctions = new Map(); // handle -> auction
  const badges = new Map(); // badge element -> handle
  let clockOffset = 0;
  let showBranding = false;
  let currencyOverride = "";

  function money(value) {
    try {
      return new Intl.NumberFormat(config.locale || undefined, {
        style: "currency",
        currency: currencyOverride || config.currency || "USD",
      }).format(Number(value));
    } catch (_) {
      return "$" + Number(value).toFixed(2);
    }
  }

  // Wording follows the language the shopper is browsing the store in (any theme).
  const LANG = String(config.locale || (window.Shopify && window.Shopify.locale) || document.documentElement.getAttribute("lang") || "en").slice(0, 2).toLowerCase();
  /*I18N:cards*/const TR = {"es":{"Test auction":"Subasta de prueba","Test auction ended":"Subasta de prueba terminada","Live auction":"Subasta en vivo","Upcoming auction":"Próxima subasta","Auction ended":"Subasta terminada","Winning Bid":"Puja ganadora","Current Bid":"Puja actual","Starting Bid":"Puja inicial","{time} left":"Quedan {time}","Starts in {time}":"Empieza en {time}","1 bid":"1 puja","{n} bids":"{n} pujas","WINNING":"GANANDO","OUTBID":"SUPERADO","WON":"GANADA","HIGH BIDDER":"MEJOR POSTOR","Reserve met":"Precio de reserva alcanzado","Reserve not met":"Precio de reserva no alcanzado","HOT":"POPULAR","{n} bidders":"{n} postores","{n} watching":"{n} siguiendo"},"fr":{"Test auction":"Enchère de test","Test auction ended":"Enchère de test terminée","Live auction":"Enchère en cours","Upcoming auction":"Enchère à venir","Auction ended":"Enchère terminée","Winning Bid":"Enchère gagnante","Current Bid":"Enchère actuelle","Starting Bid":"Mise de départ","{time} left":"Il reste {time}","Starts in {time}":"Commence dans {time}","1 bid":"1 enchère","{n} bids":"{n} enchères","WINNING":"EN TÊTE","OUTBID":"SURENCHÉRI","WON":"GAGNÉE","HIGH BIDDER":"MEILLEUR ENCHÉRISSEUR","Reserve met":"Prix de réserve atteint","Reserve not met":"Prix de réserve non atteint","HOT":"POPULAIRE","{n} bidders":"{n} enchérisseurs","{n} watching":"{n} personnes suivent"},"de":{"Test auction":"Testauktion","Test auction ended":"Testauktion beendet","Live auction":"Live-Auktion","Upcoming auction":"Kommende Auktion","Auction ended":"Auktion beendet","Winning Bid":"Siegergebot","Current Bid":"Aktuelles Gebot","Starting Bid":"Startgebot","{time} left":"Noch {time}","Starts in {time}":"Startet in {time}","1 bid":"1 Gebot","{n} bids":"{n} Gebote","WINNING":"FÜHREND","OUTBID":"ÜBERBOTEN","WON":"GEWONNEN","HIGH BIDDER":"HÖCHSTBIETENDER","Reserve met":"Mindestpreis erreicht","Reserve not met":"Mindestpreis nicht erreicht","HOT":"BELIEBT","{n} bidders":"{n} Bieter","{n} watching":"{n} beobachten"},"pt":{"Test auction":"Leilão de teste","Test auction ended":"Leilão de teste encerrado","Live auction":"Leilão ao vivo","Upcoming auction":"Próximo leilão","Auction ended":"Leilão encerrado","Winning Bid":"Lance vencedor","Current Bid":"Lance atual","Starting Bid":"Lance inicial","{time} left":"Faltam {time}","Starts in {time}":"Começa em {time}","1 bid":"1 lance","{n} bids":"{n} lances","WINNING":"GANHANDO","OUTBID":"SUPERADO","WON":"GANHO","HIGH BIDDER":"MAIOR LICITANTE","Reserve met":"Preço de reserva atingido","Reserve not met":"Preço de reserva não atingido","HOT":"EM ALTA","{n} bidders":"{n} licitantes","{n} watching":"{n} acompanhando"}};/*END*/
  function T(s, vars) {
    const D = TR[LANG];
    let out = D && Object.prototype.hasOwnProperty.call(D, s) ? D[s] : s;
    if (vars) for (const k of Object.keys(vars)) out = out.split("{" + k + "}").join(String(vars[k]));
    return out;
  }

  function handleFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) return null;
      const match = url.pathname.match(/\/products\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]).toLowerCase() : null;
    } catch (_) {
      return null;
    }
  }

  const currentPageHandle = handleFromHref(window.location.href);

  function linksIn(element) {
    return element.querySelectorAll(`a[href*="/products/"]:not([${BADGE_ATTR}])`);
  }

  // Card root = the largest nearby ancestor whose product links all point to this one product.
  function findCardRoot(link, handle) {
    let root = link;
    let node = link.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1) {
      if (STOP_TAGS.has(node.tagName)) break;
      let onlyThisProduct = true;
      for (const a of linksIn(node)) {
        const other = handleFromHref(a.getAttribute("href"));
        if (other && other !== handle) {
          onlyThisProduct = false;
          break;
        }
      }
      if (!onlyThisProduct) break;
      root = node;
      node = node.parentElement;
    }
    return root === link ? link.parentElement : root;
  }

  function formatRemaining(ms) {
    if (ms <= 0) return null;
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (d > 0) return `${d}d ${h}h ${pad(m)}m ${pad(sec)}s`;
    if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
    if (m > 0) return `${m}m ${pad(sec)}s`;
    return `${sec}s`;
  }

  function stateOf(auction, now) {
    if (now < Date.parse(auction.startsAt)) return "UPCOMING";
    if (now >= Date.parse(auction.endsAt)) return "ENDED";
    return "LIVE";
  }

  function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function render(badge, auction) {
    const now = Date.now() + clockOffset;
    const state = stateOf(auction, now);

    // Ended auctions leave the storefront a minute after they end; they live in My Auctions.
    // The card root is the largest container holding links to this one product only (see findCardRoot).
    const gone = state === "ENDED" && now - Date.parse(auction.endsAt) > 60 * 1000;
    const holder = badge.__hfRoot;
    if (holder && holder !== document.body) {
      if (gone) {
        holder.style.setProperty("display", "none", "important");
        holder.setAttribute("data-hellfire-gone", "");
      } else if (holder.hasAttribute("data-hellfire-gone")) {
        holder.style.removeProperty("display");
        holder.removeAttribute("data-hellfire-gone");
      }
    }
    if (gone) return;
    const label = T(auction.isTest
      ? state === "ENDED" ? "Test auction ended" : "Test auction"
      : state === "LIVE" ? "Live auction" : state === "UPCOMING" ? "Upcoming auction" : "Auction ended");
    const amountLabel = T(auction.hasBids ? (state === "ENDED" ? "Winning Bid" : "Current Bid") : "Starting Bid");
    let timing = "";
    if (state === "LIVE") timing = T("{time} left", { time: formatRemaining(Date.parse(auction.endsAt) - now) });
    if (state === "UPCOMING") timing = T("Starts in {time}", { time: formatRemaining(Date.parse(auction.startsAt) - now) });
    const bids = auction.bidCount === 1 ? T("1 bid") : T("{n} bids", { n: auction.bidCount });

    badge.dataset.state = state.toLowerCase();
    const mineEl = badge.querySelector(".hellfire-card-badge__mine");
    if (mineEl) {
      let mine = auction.myStatus || "";
      if (mine && state === "ENDED") mine = mine === "WINNING" && auction.reserveMet !== false ? "WON" : "";
      if (mine === "WINNING" && auction.reserveMet === false) mine = "RESERVE";
      mineEl.dataset.mine = mine.toLowerCase();
      setText(mineEl, mine === "WINNING" ? "\u2714 " + T("WINNING") : mine === "OUTBID" ? "\u2716 " + T("OUTBID") : mine === "WON" ? "\u{1F3C6} " + T("WON") : mine === "RESERVE" ? "\u2714 " + T("HIGH BIDDER") : "");
    }
    const reserveEl = badge.querySelector(".hellfire-card-badge__reserve");
    if (reserveEl) {
      const r = auction.hasReserve ? (auction.reserveMet ? "yes" : "no") : "";
      reserveEl.dataset.reserve = r;
      setText(reserveEl, r === "yes" ? "\u2714 " + T("Reserve met") : r === "no" ? T("Reserve not met") : "");
    }
    badge.dataset.hot = auction.hot && state === "LIVE" ? "true" : "false";
    setText(badge.querySelector(".hellfire-card-badge__hot"), auction.hot && state === "LIVE" ? "\u{1F525} " + T("HOT") : "");
    setText(badge.querySelector(".hellfire-card-badge__brand"), "");
    setText(badge.querySelector(".hellfire-card-badge__state"), label);
    setText(badge.querySelector(".hellfire-card-badge__amount-label"), amountLabel);
    setText(badge.querySelector(".hellfire-card-badge__amount"), money(auction.amount));
    setText(badge.querySelector(".hellfire-card-badge__meta"), timing ? `${bids} \u00b7 ${timing}` : bids);
    const socialEl = badge.querySelector(".hellfire-card-badge__social");
    if (socialEl) {
      const parts = [];
      if (state === "LIVE" && Number(auction.bidders) >= 2) parts.push(T("{n} bidders", { n: auction.bidders }));
      if (state === "LIVE" && Number(auction.watchers) >= 2) parts.push(T("{n} watching", { n: auction.watchers }));
      setText(socialEl, parts.join(" \u00b7 "));
    }
  }

  function createBadge(handle, href) {
    const badge = document.createElement("a");
    badge.setAttribute(BADGE_ATTR, "");
    badge.className = "hellfire-card-badge";
    badge.href = href;
    badge.innerHTML =
      '<span class="hellfire-card-badge__top"><span class="hellfire-card-badge__state"></span><span class="hellfire-card-badge__hot"></span></span>' +
      '<span class="hellfire-card-badge__mine"></span>' +
      '<span class="hellfire-card-badge__line"><span class="hellfire-card-badge__amount-label"></span> ' +
      '<strong class="hellfire-card-badge__amount"></strong></span>' +
      '<span class="hellfire-card-badge__reserve"></span>' +
      '<span class="hellfire-card-badge__meta"></span>' + '<span class="hellfire-card-badge__social"></span>' +
      '<span class="hellfire-card-badge__brand"></span>';
    badges.set(badge, handle);
    return badge;
  }

  function placeBadge(root, badge) {
    const price = root.querySelector('[class*="price"], [data-price], product-price');
    if (price && price.parentElement) {
      price.insertAdjacentElement("afterend", badge);
    } else {
      root.appendChild(badge);
    }
  }


  // The theme's own price on an auction card (usually $0.00) is misleading, so it is hidden -
  // but only small, price-like elements inside cards that link to an auction product.
  const PRICE_SELECTOR = '[class*="price"], .money, product-price, [data-price], [data-product-price]';
  function hideThemePrices(root) {
    const candidates = [...root.querySelectorAll(PRICE_SELECTOR)].filter(
      (el) => !el.closest(`[${BADGE_ATTR}]`),
    );
    for (const el of candidates) {
      const insideOther = candidates.some((other) => other !== el && other.contains(el));
      if (insideOther) continue;
      const text = (el.textContent || "").trim();
      if (text.length > 80 || !/\d/.test(text)) continue;
      el.setAttribute("data-hellfire-price-hidden", "");
    }
  }

  const SOLD_OUT_TEXT = /^(sold out|out of stock|unavailable)$/i;
  // Auction items are held at 0 stock on purpose; never show the theme's "Sold out" label on them.
  function hideSoldOut(root) {
    if (!root) return;
    for (const el of root.querySelectorAll("span, div, p, strong, small")) {
      if (el.children.length || el.closest(`[${BADGE_ATTR}]`)) continue;
      if (SOLD_OUT_TEXT.test((el.textContent || "").trim())) el.setAttribute("data-hellfire-price-hidden", "");
    }
  }

  function scan() {
    if (!auctions.size) return;
    for (const link of document.querySelectorAll(`a[href*="/products/"]:not([${BADGE_ATTR}])`)) {
      try {
        const handle = handleFromHref(link.getAttribute("href"));
        if (!handle || handle === currentPageHandle || !auctions.has(handle)) continue;
        if (link.closest("#hellfire-auction-root, [data-hellfire-no-badges], form[action*='/cart'], header, nav, footer")) continue;
        const root = findCardRoot(link, handle);
        if (!root || root.querySelector(`[${BADGE_ATTR}]`)) continue;
        const badge = createBadge(handle, link.href);
        placeBadge(root, badge);
        hideThemePrices(root);
        badge.__hfRoot = root;
        hideSoldOut(root);
        render(badge, auctions.get(handle));
      } catch (_) {
        // One odd card must never stop the others.
      }
    }
  }

  function tick() {
    for (const [badge, handle] of badges) {
      if (!badge.isConnected) {
        badges.delete(badge);
        continue;
      }
      hideSoldOut(badge.__hfRoot);
      const auction = auctions.get(handle);
      if (auction) render(badge, auction);
    }
  }

  async function load() {
    try {
      // The head script already asked the server at the start of the page load; use that answer if there is one.
      let data = null;
      const early = window.__hellfireCardsPrefetch;
      if (early) {
        window.__hellfireCardsPrefetch = null;
        data = await early;
      }
      if (!data) {
        const response = await fetch(ENDPOINT, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        data = await response.json();
      }
      if (data.now) clockOffset = Date.parse(data.now) - Date.now();
      if (data.currency) currencyOverride = data.currency;
      showBranding = Boolean(data.branding);
      auctions.clear();
      for (const auction of data.auctions || []) {
        if (auction && auction.handle) auctions.set(String(auction.handle).toLowerCase(), auction);
      }
      scan();
      tick();
      // Keep the pre-paint rules fresh, so the next page of this visit hides ended auctions before it paints.
      try { if (window.__hellfireEarly) window.__hellfireEarly.update(data.auctions || [], Date.now() + clockOffset); } catch (_) {}
    } catch (_) {
      // Network or proxy problem: leave the page exactly as the theme rendered it.
    }
  }

  let scanTimer = null;
  let scanQueued = false;
  const observer = new MutationObserver((mutations) => {
    const fromTheme = mutations.some((m) => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return !(el && el.closest(`[${BADGE_ATTR}]`));
    });
    if (!fromTheme) return;
    // Scan before the browser paints: cards the theme adds late (such as "You may also like") must not flash.
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      try { scan(); } catch (_) {}
    });
  });

  function start() {
    if (window.location.pathname.indexOf("/apps/hellfire-auctions/my-auctions") !== -1) return;
    load();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(tick, 1000);
    setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
