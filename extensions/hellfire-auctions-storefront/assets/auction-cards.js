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
  const REFRESH_MS = 30_000;
  const BADGE_ATTR = "data-hellfire-card-badge";
  const STOP_TAGS = new Set(["BODY", "MAIN", "SECTION", "HEADER", "FOOTER", "NAV", "UL", "OL", "DIALOG"]);

  const auctions = new Map(); // handle -> auction
  const badges = new Map(); // badge element -> handle
  let clockOffset = 0;

  function money(value) {
    try {
      return new Intl.NumberFormat(config.locale || undefined, {
        style: "currency",
        currency: config.currency || "USD",
      }).format(Number(value));
    } catch (_) {
      return "$" + Number(value).toFixed(2);
    }
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
    const label =
      state === "LIVE" ? "Live auction" : state === "UPCOMING" ? "Upcoming auction" : "Auction ended";
    const amountLabel = auction.hasBids ? (state === "ENDED" ? "Winning Bid" : "Current Bid") : "Starting Bid";
    let timing = "";
    if (state === "LIVE") timing = `${formatRemaining(Date.parse(auction.endsAt) - now)} left`;
    if (state === "UPCOMING") timing = `Starts in ${formatRemaining(Date.parse(auction.startsAt) - now)}`;
    const bids = `${auction.bidCount} bid${auction.bidCount === 1 ? "" : "s"}`;

    badge.dataset.state = state.toLowerCase();
    setText(badge.querySelector(".hellfire-card-badge__state"), label);
    setText(badge.querySelector(".hellfire-card-badge__amount-label"), amountLabel);
    setText(badge.querySelector(".hellfire-card-badge__amount"), money(auction.amount));
    setText(badge.querySelector(".hellfire-card-badge__meta"), timing ? `${bids} \u00b7 ${timing}` : bids);
  }

  function createBadge(handle, href) {
    const badge = document.createElement("a");
    badge.setAttribute(BADGE_ATTR, "");
    badge.className = "hellfire-card-badge";
    badge.href = href;
    badge.innerHTML =
      '<span class="hellfire-card-badge__state"></span>' +
      '<span class="hellfire-card-badge__line"><span class="hellfire-card-badge__amount-label"></span> ' +
      '<strong class="hellfire-card-badge__amount"></strong></span>' +
      '<span class="hellfire-card-badge__meta"></span>';
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

  function scan() {
    if (!auctions.size) return;
    for (const link of document.querySelectorAll(`a[href*="/products/"]:not([${BADGE_ATTR}])`)) {
      try {
        const handle = handleFromHref(link.getAttribute("href"));
        if (!handle || handle === currentPageHandle || !auctions.has(handle)) continue;
        if (link.closest("#hellfire-auction-root, form[action*='/cart'], header, nav, footer")) continue;
        const root = findCardRoot(link, handle);
        if (!root || root.querySelector(`[${BADGE_ATTR}]`)) continue;
        const badge = createBadge(handle, link.href);
        placeBadge(root, badge);
        hideThemePrices(root);
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
      const auction = auctions.get(handle);
      if (auction) render(badge, auction);
    }
  }

  async function load() {
    try {
      const response = await fetch(ENDPOINT, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data.now) clockOffset = Date.parse(data.now) - Date.now();
      auctions.clear();
      for (const auction of data.auctions || []) {
        if (auction && auction.handle) auctions.set(String(auction.handle).toLowerCase(), auction);
      }
      scan();
      tick();
    } catch (_) {
      // Network or proxy problem: leave the page exactly as the theme rendered it.
    }
  }

  let scanTimer = null;
  const observer = new MutationObserver((mutations) => {
    const fromTheme = mutations.some((m) => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return !(el && el.closest(`[${BADGE_ATTR}]`));
    });
    if (!fromTheme) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  });

  function start() {
    load();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(tick, 1000);
    setInterval(load, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
