(() => {
  "use strict";

  const API_PATH = "/apps/hellfire-auctions/auction";
  const ROOT_SELECTOR = "#hellfire-auction-root";
  const initialized = new WeakSet();

  const isPurchaseControl = (el) =>
    el?.matches?.('form[action*="/cart/add"], .quick-add, .quick-add__button, button[name="add"], .add-to-cart-button, .shopify-payment-button, .buy-buttons, sticky-add-to-cart, .sticky-add-to-cart__bar, [data-testid="checkout-button"]') ||
    el?.closest?.('form[action*="/cart/add"], .quick-add, .quick-add__button, button[name="add"], .add-to-cart-button, .shopify-payment-button, .buy-buttons, sticky-add-to-cart, .sticky-add-to-cart__bar, [data-testid="checkout-button"]');

  const hidePurchaseControls = () => {
    document.querySelectorAll('form[action*="/cart/add"], .quick-add, .quick-add__button, .shopify-payment-button, button[name="add"], .buy-buttons, sticky-add-to-cart, .sticky-add-to-cart__bar, .add-to-cart-button, [data-testid="checkout-button"]')
      .forEach((el) => el.style.setProperty("display", "none", "important"));
  };

  document.addEventListener("click", (event) => {
    if (isPurchaseControl(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener("submit", (event) => {
    if (isPurchaseControl(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  const money = (v) => "$" + Number(v || 0).toFixed(2);

  function shell(root, title, status) {
    root.innerHTML = '<section class="hellfire-auction-card" aria-label="Hellfire auction">' +
      '<div class="hellfire-auction-badge">🔥 HELLFIRE AUCTIONS</div>' +
      '<h2 class="hellfire-auction-title">' + title + '</h2>' +
      '<div class="hellfire-auction-status">' + status + '</div></section>';
  }

  async function load(root) {
    const productId = root.dataset.productId;
    if (!productId) return;

    const api = API_PATH + "?product_id=" + encodeURIComponent("gid://shopify/Product/" + productId);
    if (!root.querySelector(".hellfire-auction-card")) {
      shell(root, "Loading live auction…", "Connecting to the auction service…");
    }

    try {
      const response = await fetch(api, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" }
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error("Auction API returned HTTP " + response.status + " instead of JSON."); }

      if (!response.ok || !data.auction) {
        console.error("HELLFIRE AUCTIONS API:", response.status, data);
        shell(root, "Auction temporarily unavailable", "The auction service did not return auction data.");
        return;
      }

      const a = data.auction;
      root.innerHTML =
        '<section class="hellfire-auction-card" aria-label="Live auction">' +
        '<div class="hellfire-auction-badge">🔥 LIVE AUCTION</div>' +
        '<h2 class="hellfire-auction-title">' + a.title + '</h2>' +
        '<div class="hellfire-auction-grid">' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bid</span><span class="hellfire-auction-value">' + money(a.currentBid || a.startingBid) + '</span></div>' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Starting Bid</span><span class="hellfire-auction-value">' + money(a.startingBid) + '</span></div>' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Bids</span><span class="hellfire-auction-value">' + (a.bids?.length || 0) + '</span></div>' +
        '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bidder</span><span class="hellfire-auction-value hellfire-auction-bidder">' + (a.highestBidder || "No bids") + '</span></div>' +
        '</div><div class="hellfire-auction-countdown"></div><div class="hellfire-auction-status">Auction is LIVE</div>' +
        (data.loggedInCustomerId ? '<form class="hellfire-auction-bid-form"><input name="amount" type="number" step="0.01" min="' + (Number(a.currentBid || a.startingBid) + 1).toFixed(2) + '" placeholder="Enter your maximum bid" aria-label="Maximum bid" required><button type="submit">PLACE BID 🔥</button></form><div class="hellfire-auction-message"></div>' : '<div class="hellfire-auction-login">Log in to your customer account to place a bid.</div>') +
        '</section>';

      hidePurchaseControls();
      const countdown = root.querySelector(".hellfire-auction-countdown");
      const tick = () => {
        const ms = new Date(a.endsAt).getTime() - Date.now();
        if (ms <= 0) { countdown.textContent = "Auction ended"; return; }
        const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        countdown.innerHTML = "⏳ " + d + "d " + h + "h " + m + "m " + sec + "s <span class='hellfire-auction-remaining'>remaining</span>";
      };
      tick();
      setInterval(tick, 1000);

      const form = root.querySelector("form.hellfire-auction-bid-form");
      if (form) {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const msg = root.querySelector(".hellfire-auction-message");
          const button = form.querySelector("button");
          button.disabled = true;
          msg.textContent = "Submitting bid…";
          try {
            const body = new FormData(form);
            body.append("product_id", "gid://shopify/Product/" + productId);
            const response = await fetch(API_PATH, { method: "POST", credentials: "same-origin", body });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Bid failed");
            await load(root);
          } catch (err) {
            msg.textContent = err.message;
            button.disabled = false;
          }
        });
      }
    } catch (err) {
      console.error("HELLFIRE AUCTIONS:", err);
      shell(root, "Auction connection failed", "The auction block stayed mounted, but its API request failed. Check the browser console for details.");
    }
  }

  function initialize(root) {
    if (!(root instanceof HTMLElement) || initialized.has(root)) return;
    initialized.add(root);
    load(root);
  }

  function scan() {
    document.querySelectorAll(ROOT_SELECTOR).forEach(initialize);
    hidePurchaseControls();
  }

  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
