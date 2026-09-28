(() => {
  "use strict";

  const AUCTION_ATTR = "data-hellfire-auction";
  let auctionIds = new Set();
  let loading = false;

  const productId = (node) => {
    let el = node;
    while (el && el !== document) {
      const raw = el.getAttribute?.("data-product-id");
      const match = String(raw || "").match(/(?:gid:\/\/shopify\/Product\/)?(\d+)/);
      if (match) return match[1];
      el = el.parentElement;
    }
    return "";
  };

  const mark = (container) => {
    if (!container || container === document.documentElement) return;
    container.setAttribute(AUCTION_ATTR, "true");
  };

  const markAuctionProducts = () => {
    for (const id of auctionIds) {
      const selector = [
        '[data-product-id="' + id + '"]',
        '[data-product-id="gid://shopify/Product/' + id + '"]'
      ].join(",");
      document.querySelectorAll(selector).forEach(mark);
    }
  };

  const hideAuctionPurchaseUI = () => {
    document.querySelectorAll('[' + AUCTION_ATTR + '="true"]').forEach((container) => {
      if (container.matches("form[action*='/cart/add'], quick-add-component, add-to-cart-component, sticky-add-to-cart")) {
        container.style.setProperty("display", "none", "important");
      }
      container.querySelectorAll([
        "quick-add-component",
        "add-to-cart-component",
        "sticky-add-to-cart",
        "form[action*='/cart/add']",
        "button[name='add']",
        "[data-testid*='add-to-cart']",
        "[data-action='add-to-cart']",
        "[data-add-to-cart]"
      ].join(",")).forEach((el) => {
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("pointer-events", "none", "important");
      });
    });
  };

  const apply = () => {
    markAuctionProducts();
    hideAuctionPurchaseUI();
  };

  const loadAuctionIds = async () => {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch(
        "/apps/hellfire-auctions/auction-products",
        { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } },
      );
      if (!response.ok) throw new Error("auction product lookup failed");
      const data = await response.json();
      auctionIds = new Set(
        (data.auctionProductIds || []).map((id) =>
          String(id).replace(/^gid:\/\/shopify\/Product\//, ""),
        ),
      );
      apply();
    } catch (_) {
      // Keep the observer alive and retry on the next interval.
    } finally {
      loading = false;
    }
  };

  apply();
  loadAuctionIds();

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-product-id"],
  });

  setInterval(loadAuctionIds, 10000);
})();
