(() => {
  "use strict";

  const root = document.getElementById("hellfire-auction-root");
  if (!root) return;

  const productId = root.dataset.productId;
  if (!productId) return;

  const isPurchaseControl = (el) =>
    el?.matches?.('form[action*="/cart/add"], .quick-add, .quick-add__button, button[name="add"], .add-to-cart-button, .shopify-payment-button, .buy-buttons, sticky-add-to-cart, .sticky-add-to-cart__bar, [data-testid="checkout-button"]') ||
    el?.closest?.('form[action*="/cart/add"], .quick-add, .quick-add__button, button[name="add"], .add-to-cart-button, .shopify-payment-button, .buy-buttons, sticky-add-to-cart, .sticky-add-to-cart__bar, [data-testid="checkout-button"]');

  const blockPurchaseEvent = (event) => {
    if (isPurchaseControl(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  document.addEventListener("click", blockPurchaseEvent, true);
  document.addEventListener("submit", blockPurchaseEvent, true);

  const hidePurchaseControls = () =>
    document.querySelectorAll('form[action*="/cart/add"], .quick-add, .quick-add__button, .shopify-payment-button, button[name="add"], .buy-buttons, sticky-add-to-cart, .sticky-add-to-cart__bar, .add-to-cart-button, [data-testid="checkout-button"]')
      .forEach((el) => el.style.setProperty("display", "none", "important"));

  hidePurchaseControls();

  const observer = new MutationObserver(hidePurchaseControls);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const api = "/apps/hellfire-auctions/auction?product_id=" + encodeURIComponent("gid://shopify/Product/" + productId);
  const money = (v) => "$" + Number(v || 0).toFixed(2);

  async function load() {
    root.innerHTML = '<section class="hellfire-auction-card"><div class="hellfire-auction-badge">🔥 HELLFIRE AUCTIONS</div><h2>Loading live auction…</h2></section>';
    try {
      const response = await fetch(api, { credentials: "same-origin", headers: { Accept: "application/json" } });
      const data = await response.json();

      if (!response.ok || !data.auction) {
        root.innerHTML = "";
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
          '</div>' +
          '<div class="hellfire-auction-countdown"></div>' +
          '<div class="hellfire-auction-status">Auction is LIVE</div>' +
          (data.loggedInCustomerId ?
            '<form class="hellfire-auction-bid-form"><input name="amount" type="number" step="0.01" min="' + (Number(a.currentBid || a.startingBid) + 1).toFixed(2) + '" placeholder="Enter your maximum bid" aria-label="Maximum bid" required><button type="submit">PLACE BID 🔥</button></form><div class="hellfire-auction-message"></div>' :
            '<div class="hellfire-auction-login">Log in to your customer account to place a bid.</div>') +
        '</section>';

      hidePurchaseControls();

      const countdown = root.querySelector(".hellfire-auction-countdown");
      const tick = () => {
        const ms = new Date(a.endsAt).getTime() - Date.now();
        if (ms <= 0) {
          countdown.textContent = "Auction ended";
          return;
        }
        const s = Math.floor(ms / 1000);
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        countdown.innerHTML = "⏱ " + d + "d " + h + "h " + m + "m " + sec + "s <span class='hellfire-auction-remaining'>remaining</span>";
      };

      tick();
      setInterval(tick, 1000);

      const form = root.querySelector("form");
      if (form) {
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          e.stopPropagation();

          const msg = root.querySelector(".hellfire-auction-message");
          const button = form.querySelector("button");

          button.disabled = true;
          msg.textContent = "Submitting bid…";

          try {
            const body = new FormData(form);
            body.append("product_id", "gid://shopify/Product/" + productId);

            const r = await fetch("/apps/hellfire-auctions/auction", {
              method: "POST",
              credentials: "same-origin",
              body,
            });

            const result = await r.json();
            if (!r.ok) throw new Error(result.error || "Bid failed");

            await load();
          } catch (err) {
            msg.textContent = err.message;
            button.disabled = false;
          }
        });
      }
    } catch (err) {
      console.error("HELLFIRE AUCTIONS:", err);
      root.innerHTML = "";
    }
  }

  load();
})();
