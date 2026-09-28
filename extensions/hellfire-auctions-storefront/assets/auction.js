(() => {
  "use strict";

  const API_PATH = "/apps/hellfire-auctions/auction";
  const ROOT_SELECTOR = "#hellfire-auction-root";
  const root = document.querySelector(ROOT_SELECTOR);
  const productId = root?.dataset.productId || window.ShopifyAnalytics?.meta?.product?.id;
  const money = (value) => "$" + Number(value || 0).toFixed(2);

  function hidePurchaseControls() {
    document.querySelectorAll(
      'form[action*="/cart/add"],.quick-add,.quick-add__button,' +
      '.shopify-payment-button,button[name="add"],.buy-buttons,' +
      'sticky-add-to-cart,.sticky-add-to-cart__bar,.add-to-cart-button,' +
      '[data-testid="checkout-button"]'
    ).forEach((el) => {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
    });
  }

  async function load() {
    if (!root || !productId) return;
    const api = API_PATH + "?product_id=" +
      encodeURIComponent("gid://shopify/Product/" + productId);
    try {
      const response = await fetch(api, {
        credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json" }
      });
      const data = await response.json();
      if (!response.ok || !data.auction) throw new Error("Auction API HTTP " + response.status);
      const a = data.auction;
      root.innerHTML = '<section class="hellfire-auction-card" aria-label="Live auction">' +
        '<div class="hellfire-auction-badge">HELLFIRE AUCTIONS</div>' +
        '<h2 class="hellfire-auction-title"></h2>' +
        '<div class="hellfire-auction-grid">' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bid</span><span class="hellfire-auction-value">' + money(a.currentBid || a.startingBid) + '</span></div>' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Starting Bid</span><span class="hellfire-auction-value">' + money(a.startingBid) + '</span></div>' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Bids</span><span class="hellfire-auction-value">' + (a.bids?.length || 0) + '</span></div>' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bidder</span><span class="hellfire-auction-value hellfire-auction-bidder">' + (a.highestBidder || "No bids") + '</span></div>' +
        '</div><div class="hellfire-auction-countdown"></div>' +
        '<div class="hellfire-auction-status">Auction is LIVE</div>' +
        (data.loggedInCustomerId ? '<form class="hellfire-auction-bid-form"><input name="amount" type="number" step="0.01" required><button type="submit">PLACE BID</button></form><div class="hellfire-auction-message"></div>' : '<div class="hellfire-auction-login">Log in to your customer account to place a bid.</div>') +
        '</section>';
      root.querySelector(".hellfire-auction-title").textContent = a.title;
      const countdown = root.querySelector(".hellfire-auction-countdown");
      const tick = () => {
        const seconds = Math.max(0, Math.floor((new Date(a.endsAt).getTime() - Date.now()) / 1000));
        const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
        countdown.textContent = seconds ? d + "d " + h + "h " + m + "m " + s + "s remaining" : "Auction ended";
      };
      tick();
      root._hellfireTimer = setInterval(tick, 1000);
    } catch (error) {
      console.error("HELLFIRE AUCTIONS", error);
      const status = root.querySelector(".hellfire-auction-status");
      if (status) status.textContent = "Auction connection failed.";
    }
  }

  hidePurchaseControls();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { hidePurchaseControls(); load(); }, { once: true });
  } else {
    load();
  }
})();
