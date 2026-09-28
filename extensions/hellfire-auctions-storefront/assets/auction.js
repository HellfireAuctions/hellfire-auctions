(() => {
  "use strict";

  const API_PATH = "/apps/hellfire-auctions/auction";
  const ROOT_SELECTOR = "#hellfire-auction-root";
  let productId = null;
  let observerStarted = false;

  const money = (value) => "$" + Number(value || 0).toFixed(2);

  function discoverProductId() {
    const analyticsId = window.ShopifyAnalytics?.meta?.product?.id;
    if (analyticsId) return String(analyticsId);
    const root = document.querySelector(ROOT_SELECTOR);
    return root?.dataset.productId || null;
  }

  function findHost() {
    return document.querySelector('[data-testid="product-information"]')
      || document.querySelector(".product-information");
  }

  function createRoot(host) {
    const root = document.createElement("div");
    root.id = "hellfire-auction-root";
    root.dataset.productId = productId;
    root.innerHTML = '<section class="hellfire-auction-card" aria-label="Hellfire auction">' +
      '<div class="hellfire-auction-badge">HELLFIRE AUCTIONS</div>' +
      '<h2 class="hellfire-auction-title">Loading live auction...</h2>' +
      '<div class="hellfire-auction-status">Connecting to the auction service...</div>' +
      "</section>";
    host.appendChild(root);
    return root;
  }

  function ensureRoot() {
    let root = document.querySelector(ROOT_SELECTOR);
    if (root) {
      productId ||= root.dataset.productId;
      return root;
    }
    productId ||= discoverProductId();
    const host = findHost();
    return productId && host ? createRoot(host) : null;
  }

  function hidePurchaseControls() {
    document.querySelectorAll(
      'form[action*="/cart/add"], .quick-add, .quick-add__button, ' +
      '.shopify-payment-button, button[name="add"], .buy-buttons, ' +
      'sticky-add-to-cart, .sticky-add-to-cart__bar, .add-to-cart-button, ' +
      '[data-testid="checkout-button"]'
    ).forEach((el) => {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
    });
  }

  async function load(root) {
    if (!root || root.dataset.loading === "1" || root.dataset.loaded === "1") return;
    root.dataset.loading = "1";
    const api = API_PATH + "?product_id=" +
      encodeURIComponent("gid://shopify/Product/" + productId);

    try {
      const response = await fetch(api, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      const body = await response.text();
      const data = JSON.parse(body);
      if (!response.ok || !data.auction) {
        throw new Error("Auction API returned HTTP " + response.status);
      }
      if (!root.isConnected) return;

      const a = data.auction;
      root.innerHTML = '<section class="hellfire-auction-card" aria-label="Live auction">' +
        '<div class="hellfire-auction-badge">HELLFIRE AUCTIONS</div>' +
        '<h2 class="hellfire-auction-title"></h2>' +
        '<div class="hellfire-auction-grid">' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bid</span><span class="hellfire-auction-value">' + money(a.currentBid || a.startingBid) + "</span></div>" +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Starting Bid</span><span class="hellfire-auction-value">' + money(a.startingBid) + "</span></div>" +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Bids</span><span class="hellfire-auction-value">' + (a.bids?.length || 0) + "</span></div>" +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bidder</span><span class="hellfire-auction-value hellfire-auction-bidder">' + (a.highestBidder || "No bids") + "</span></div>" +
        '</div><div class="hellfire-auction-countdown"></div>' +
        '<div class="hellfire-auction-status">Auction is LIVE</div>' +
        (data.loggedInCustomerId
          ? '<form class="hellfire-auction-bid-form"><input name="amount" type="number" step="0.01" required><button type="submit">PLACE BID</button></form><div class="hellfire-auction-message"></div>'
          : '<div class="hellfire-auction-login">Log in to your customer account to place a bid.</div>') +
        "</section>";

      root.querySelector(".hellfire-auction-title").textContent = a.title;
      const countdown = root.querySelector(".hellfire-auction-countdown");
      const tick = () => {
        const seconds = Math.max(0, Math.floor((new Date(a.endsAt).getTime() - Date.now()) / 1000));
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        countdown.textContent = seconds ? d + "d " + h + "h " + m + "m " + s + "s remaining" : "Auction ended";
      };
      tick();
      root._hellfireTimer = setInterval(tick, 1000);
      root.dataset.loaded = "1";
    } catch (error) {
      console.error("HELLFIRE AUCTIONS", error);
      const status = root.querySelector(".hellfire-auction-status");
      if (status) status.textContent = "Auction connection failed.";
    } finally {
      root.dataset.loading = "0";
    }
  }

  function start() {
    productId ||= discoverProductId();
    const root = ensureRoot();
    if (root) load(root);
    hidePurchaseControls();

    if (observerStarted) return;
    observerStarted = true;
    const observer = new MutationObserver(() => {
      const current = ensureRoot();
      if (current && current.dataset.loaded !== "1") load(current);
      hidePurchaseControls();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();