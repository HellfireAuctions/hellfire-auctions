(() => {
  "use strict";

  const API_PATH = "/apps/hellfire-auctions/auction";
  const RUNTIME = "hellfire-auction-runtime";
  const HOST = "hellfire-auction-host";
  let productId = null;
  let mountQueued = false;

  function discoverProductId() {
    return window.__HELLFIRE_AUCTION_PRODUCT_ID ||
      document.getElementById(RUNTIME)?.dataset.productId ||
      window.ShopifyAnalytics?.meta?.product?.id ||
      null;
  }

  const css = `
    :host { display:block; width:100%; box-sizing:border-box; contain:content; }
    .card { width:100%; margin:24px 0; padding:28px; border:2px solid #ffff00;
      border-radius:16px; background:#000; color:#f5f5f5; box-sizing:border-box;
      box-shadow:0 8px 30px rgba(255,43,214,.2); font-family:Arial,sans-serif; }
    .badge { display:inline-block; padding:6px 12px; border-radius:999px;
      background:#f5f5f5; color:#000; font-weight:800; font-size:12px;
      letter-spacing:.08em; margin-bottom:12px; }
    h2 { font-size:clamp(24px,3vw,38px); font-weight:800; margin:0 0 16px; color:#f5f5f5; }
    .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:16px 0 20px; }
    .stat { padding:14px; border:1px solid rgba(255,255,255,.18); border-radius:10px;
      background:rgba(255,255,255,.06); }
    .label { display:block; font-size:12px; opacity:.75; text-transform:uppercase; letter-spacing:.06em; }
    .value { display:block; font-size:24px; font-weight:800; margin-top:4px; color:#ffff00; }
    .bidder { font-size:18px; }
    .countdown { font-size:20px; font-weight:800; margin:12px 0; }
    .status { font-weight:700; margin-bottom:18px; }
    .login { padding:14px; border-radius:8px; background:rgba(255,255,255,.08); font-weight:700; }
    @media(max-width:700px){ .grid{grid-template-columns:1fr;} }
  `;

  function createHost() {
    let host = document.getElementById(HOST);
    if (host && host.isConnected) return host;
    host = document.createElement("div");
    host.id = HOST;
    host.setAttribute("data-hellfire-owned", "true");
    host.style.cssText = "display:block!important;visibility:visible!important;opacity:1!important;position:relative!important;z-index:2147483647!important;width:100%!important;min-height:1px!important;";
    host.dataset.productId = String(productId || "");
    document.body.appendChild(host);
    const shadow = host.attachShadow({mode:"open"});
    const style = document.createElement("style");
    style.textContent = css;
    shadow.appendChild(style);
    const card = document.createElement("section");
    card.className = "card";
    card.setAttribute("aria-label","Hellfire auction");
    card.innerHTML = '<div class="badge">HELLFIRE AUCTIONS</div><h2>Loading live auction…</h2><div class="status">Connecting to the auction service…</div>';
    shadow.appendChild(card);
    return host;
  }

  async function load(host) {
    if (!host || host.dataset.loaded === "1" || !productId) return;
    host.dataset.loading = "1";
    try {
      const response = await fetch(API_PATH + "?product_id=" +
        encodeURIComponent("gid://shopify/Product/" + productId), {
          credentials:"same-origin", cache:"no-store",
          headers:{Accept:"application/json"}
        });
      const data = await response.json();
      if (!response.ok || !data.auction) throw new Error("Auction API HTTP " + response.status);
      const a = data.auction;
      const shadow = host.shadowRoot;
      shadow.querySelector("section").innerHTML =
        '<div class="badge">HELLFIRE AUCTIONS</div><h2></h2>' +
        '<div class="grid">' +
        '<div class="stat"><span class="label">Highest Bid</span><span class="value">' + money(a.currentBid || a.startingBid) + '</span></div>' +
        '<div class="stat"><span class="label">Starting Bid</span><span class="value">' + money(a.startingBid) + '</span></div>' +
        '<div class="stat"><span class="label">Bids</span><span class="value">' + (a.bids?.length || 0) + '</span></div>' +
        '<div class="stat"><span class="label">Highest Bidder</span><span class="value bidder">' + (a.highestBidder || "No bids") + '</span></div>' +
        '</div><div class="countdown"></div><div class="status">Auction is LIVE</div>' +
        (data.loggedInCustomerId ? '<form class="bid-form"><input name="amount" type="number" step="0.01" required><button type="submit">PLACE BID</button></form>' :
          '<div class="login">Log in to your customer account to place a bid.</div>');
      shadow.querySelector("h2").textContent = a.title;
      const countdown = shadow.querySelector(".countdown");
      const tick = () => {
        const seconds = Math.max(0, Math.floor((new Date(a.endsAt).getTime() - Date.now()) / 1000));
        const d = Math.floor(seconds/86400), h = Math.floor(seconds%86400/3600);
        const m = Math.floor(seconds%3600/60), s = seconds%60;
        countdown.textContent = seconds ? d+"d "+h+"h "+m+"m "+s+"s remaining" : "Auction ended";
      };
      tick(); host._timer = setInterval(tick,1000);
      host.dataset.loaded = "1";
    } catch (e) {
      console.error("HELLFIRE AUCTIONS",e);
      const status = host.shadowRoot?.querySelector(".status");
      if (status) status.textContent = "Auction connection failed.";
    } finally { host.dataset.loading = "0"; }
  }

  function money(v) { return "$" + Number(v || 0).toFixed(2); }

  function mount() {
    mountQueued = false;
    productId ||= discoverProductId();
    if (!document.body || !productId) {
      if (!productId) setTimeout(scheduleMount, 100);
      return;
    }
    const host = createHost();
    load(host);
  }

  function scheduleMount() {
    if (mountQueued) return;
    mountQueued = true;
    queueMicrotask(mount);
  }

  function onPageLifecycle() {
    setTimeout(scheduleMount, 0);
    setTimeout(scheduleMount, 250);
    setTimeout(scheduleMount, 1000);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", onPageLifecycle, {once:true});
  else onPageLifecycle();

  window.addEventListener("pageshow", onPageLifecycle);
  window.addEventListener("popstate", onPageLifecycle);
  window.addEventListener("shopify:page:view", onPageLifecycle);
  window.addEventListener("shopify:product:view", onPageLifecycle);
  window.addEventListener("shopify:section:load", onPageLifecycle);

  const originalPushState = history.pushState;
  history.pushState = function() {
    const result = originalPushState.apply(this, arguments);
    onPageLifecycle();
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function() {
    const result = originalReplaceState.apply(this, arguments);
    onPageLifecycle();
    return result;
  };

  const observer = new MutationObserver(() => {
    const host = document.getElementById(HOST);
    if (!host || !host.isConnected) scheduleMount();
  });
  observer.observe(document.documentElement, {childList:true, subtree:true});
})();
