(() => {
  "use strict";

  const root = document.getElementById("hellfire-auction-root");
  if (!root) return;

  const productId = root.dataset.productId;
  if (!productId) return;

  const variantId = root.dataset.variantId;

  const isAuctionProductForm = (form) => {
    if (!form?.matches?.('form[action*="/cart/add"]')) return false;
    if (!variantId) return false;
    return Array.from(form.elements || []).some((field) => field.name === "id" && field.value === variantId);
  };

  const isAuctionProductContainer = (el) => {
    const container = el?.closest?.("[data-product-id], [data-current-variant-id]");
    if (!container) return false;
    return container.getAttribute("data-product-id") === productId ||
      container.getAttribute("data-current-variant-id") === variantId;
  };

  const isPurchaseControl = (el) => {
    const form = el?.closest?.('form[action*="/cart/add"]');
    if (form && isAuctionProductForm(form)) return true;

    const formId = el?.getAttribute?.("form");
    if (formId) {
      const associatedForm = document.getElementById(formId);
      if (isAuctionProductForm(associatedForm)) return true;
    }

    if (isAuctionProductContainer(el)) {
      const tag = el.tagName?.toLowerCase();
      const type = el.getAttribute?.("type")?.toLowerCase();
      const name = el.getAttribute?.("name")?.toLowerCase();
      const text = el.textContent?.trim().toLowerCase() || "";
      return (tag === "button" || tag === "input") &&
        (type === "submit" || name === "add" ||
          /add to cart|buy now|purchase/.test(text));
    }

    return false;
  };

  const blockPurchaseEvent = (event) => {
    if (isPurchaseControl(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  document.addEventListener("click", blockPurchaseEvent, true);
  document.addEventListener("submit", blockPurchaseEvent, true);

  const hidePurchaseControls = () => {
    document.querySelectorAll('form[action*="/cart/add"]').forEach((form) => {
      if (!isAuctionProductForm(form)) return;
      form.style.setProperty("display", "none", "important");

      const formId = form.id;
      if (formId) {
        document.querySelectorAll('[form="' + formId + '"]').forEach((control) => {
          control.style.setProperty("display", "none", "important");
        });
      }
    });

    document.querySelectorAll("[data-product-id], [data-current-variant-id]").forEach((container) => {
      if (container.getAttribute("data-product-id") !== productId &&
          container.getAttribute("data-current-variant-id") !== variantId) return;

      // Horizon quick-add controls live on product cards and can use icon-only labels.
      if (container.matches("quick-add-component, .quick-add, product-card")) {
        container.style.setProperty("display", "none", "important");
        container.style.setProperty("visibility", "hidden", "important");
        container.style.setProperty("pointer-events", "none", "important");
        return;
      }

      container.querySelectorAll("button, input, quick-add-component, .quick-add").forEach((control) => {
        if (control.matches("quick-add-component, .quick-add") || isPurchaseControl(control)) {
          control.style.setProperty("display", "none", "important");
          control.style.setProperty("visibility", "hidden", "important");
          control.style.setProperty("pointer-events", "none", "important");
        }
      });
    });

  hidePurchaseControls();

  const observer = new MutationObserver(hidePurchaseControls);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const api = "/apps/hellfire-auctions/auction?product_id=" + encodeURIComponent("gid://shopify/Product/" + productId);
  const money = (v) => "$" + Number(v || 0).toFixed(2);
  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    })[char]);

  let countdownTimer = null;
  let refreshTimer = null;
  let lastAuction = null;

  const renderUnavailable = () => {
    root.innerHTML = '<section class="hellfire-auction-card"><div class="hellfire-auction-badge">🔥 HELLFIRE AUCTIONS</div><h2>Auction temporarily unavailable</h2><div class="hellfire-auction-status">We will retry automatically.</div></section>';
  };

  const startCountdown = (endsAt) => {
    clearInterval(countdownTimer);
    const tick = () => {
      const countdown = root.querySelector(".hellfire-auction-countdown");
      if (!countdown) return;
      const ms = new Date(endsAt).getTime() - Date.now();
      if (ms <= 0) {
        countdown.textContent = "Auction ended";
        clearInterval(countdownTimer);
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
    countdownTimer = setInterval(tick, 1000);
  };

  const updateAuctionView = (data) => {
    const a = data.auction;
    lastAuction = a;

    const currentBid = Number(a.currentBid || 0);
    const visibleBid = currentBid || Number(a.startingBid);
    const minimumBid = currentBid > 0 ? currentBid + 1 : Number(a.startingBid);
    const statusText = a.status === "UPCOMING"
      ? "Auction has not started yet"
      : a.status === "ENDED"
        ? "Auction has ended"
        : "Auction is LIVE";

    if (!root.querySelector(".hellfire-auction-current-bid")) {
      root.innerHTML =
        '<section class="hellfire-auction-card" aria-label="Live auction">' +
          '<div class="hellfire-auction-badge">🔥 LIVE AUCTION</div>' +
          '<h2 class="hellfire-auction-title">' + escapeHtml(a.title) + '</h2>' +
          '<div class="hellfire-auction-grid">' +
            '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bid</span><span class="hellfire-auction-value hellfire-auction-current-bid"></span></div>' +
            '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Starting Bid</span><span class="hellfire-auction-value hellfire-auction-starting-bid"></span></div>' +
            '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Bids</span><span class="hellfire-auction-value hellfire-auction-bid-count"></span></div>' +
            '<div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bidder</span><span class="hellfire-auction-value hellfire-auction-bidder"></span></div>' +
          '</div>' +
          '<div class="hellfire-auction-countdown"></div>' +
          '<div class="hellfire-auction-status"></div>' +
          (data.loggedInCustomerId ?
            '<form class="hellfire-auction-bid-form"><input name="amount" type="number" step="0.01" placeholder="Enter your maximum bid" aria-label="Maximum bid" required><button type="submit">PLACE BID 🔥</button></form><div class="hellfire-auction-message"></div>' :
            '<div class="hellfire-auction-login">Log in to your customer account to place a bid.</div>') +
        '</section>';
    }

    root.querySelector(".hellfire-auction-current-bid").textContent = money(visibleBid);
    root.querySelector(".hellfire-auction-starting-bid").textContent = money(a.startingBid);
    root.querySelector(".hellfire-auction-bid-count").textContent = String(a.bids?.length || 0);
    root.querySelector(".hellfire-auction-bidder").textContent = a.highestBidder || "No bids";
    root.querySelector(".hellfire-auction-status").textContent = statusText;

    const input = root.querySelector(".hellfire-auction-bid-form input");
    const button = root.querySelector(".hellfire-auction-bid-form button");
    if (input) {
      input.min = minimumBid.toFixed(2);
      input.disabled = a.status !== "LIVE";
      if (!input.value) input.placeholder = "Minimum " + money(minimumBid);
    }
    if (button) button.disabled = a.status !== "LIVE";

    startCountdown(a.endsAt);
    hidePurchaseControls();
  };

  const bindBidForm = () => {
    const form = root.querySelector(".hellfire-auction-bid-form");
    if (!form || form.dataset.bound === "true") return;
    form.dataset.bound = "true";

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

        const response = await fetch("/apps/hellfire-auctions/auction", {
          method: "POST",
          credentials: "same-origin",
          body,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Bid failed");

        form.reset();
        msg.textContent = "Bid accepted.";
        await refreshAuction();
      } catch (err) {
        msg.textContent = err.message;
        button.disabled = false;
      }
    });
  };

  async function refreshAuction() {
    try {
      const response = await fetch(api, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data.auction) {
        if (!lastAuction) renderUnavailable();
        return;
      }
      updateAuctionView(data);
      bindBidForm();
    } catch (err) {
      console.error("HELLFIRE AUCTIONS:", err);
      if (!lastAuction) renderUnavailable();
    }
  }

  async function load() {
    lastAuction = null;
    clearInterval(refreshTimer);
    root.innerHTML = '<section class="hellfire-auction-card"><div class="hellfire-auction-badge">🔥 HELLFIRE AUCTIONS</div><h2>Loading live auction…</h2></section>';
    await refreshAuction();
    refreshTimer = setInterval(refreshAuction, 5000);
  }

  load();
})();
