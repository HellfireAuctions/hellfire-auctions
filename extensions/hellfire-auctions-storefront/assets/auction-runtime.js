(() => {
  "use strict";

  // Universal storefront runtime. It does not depend on any theme's CSS/classes.
  const root = document.getElementById("hellfire-auction-runtime");
  const cache = new Map();
  const hidden = new WeakSet();
  const productPattern = /(?:gid:\/\/shopify\/Product\/)?(\d+)/;

  const productIdOf = (el) => {
    let node = el;
    while (node && node !== document) {
      const values = [node.getAttribute?.("data-product-id"), node.getAttribute?.("data-productid"), node.getAttribute?.("data-product")];
      for (const value of values) {
        const match = String(value || "").match(productPattern);
        if (match) return match[1];
      }
      node = node.parentElement;
    }
    return root?.dataset.productId || "";
  };

  const productHandleOf = (el) => {
    let node = el;
    while (node && node !== document) {
      const link = node.matches?.('a[href*="/products/"]')
        ? node
        : node.querySelector?.('a[href*="/products/"]');
      if (link) {
        try {
          const url = new URL(link.href, location.origin);
          const match = url.pathname.match(/\/products\/([^/?#]+)/);
          if (match) return decodeURIComponent(match[1]);
        } catch (_) {}
      }
      node = node.parentElement;
    }
    return "";
  };

  const isPurchaseControl = (el) => {
    if (!el || el === root) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === "form" && /\/cart\/add/.test(el.getAttribute("action") || "")) return true;
    if ((tag === "button" || tag === "input") && (el.name || "").toLowerCase() === "add") return true;
    if (tag === "button" || tag === "input") {
      const text = (el.textContent || el.value || "").trim().toLowerCase();
      if (/^(add to cart|add to bag|buy now|purchase)$/.test(text)) return true;
    }
    if (tag === "quick-add-component" || tag === "add-to-cart-component" || tag === "sticky-add-to-cart") return true;
    if (el.matches?.('[data-testid*="add-to-cart"], [data-action="add-to-cart"], [data-add-to-cart]')) return true;
    return false;
  };

  const hide = (el) => {
    if (hidden.has(el)) return;
    hidden.add(el);
    el.dataset.hellfireAuctionSuppressed = "true";
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
  };

  const productIdForHandle = async (handle) => {
    const key = "handle:" + handle;
    if (cache.has(key)) return cache.get(key);
    const promise = fetch("/products/" + encodeURIComponent(handle) + ".js", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store"
    }).then(async response => {
      if (!response.ok) return "";
      const data = await response.json();
      return String(data.id || "");
    }).catch(() => "");
    cache.set(key, promise);
    return promise;
  };

  const auctionFor = async (productId) => {
    if (!productId) return null;
    if (cache.has(productId)) return cache.get(productId);
    const promise = fetch("/apps/hellfire-auctions/auction?product_id=" + encodeURIComponent("gid://shopify/Product/" + productId), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store"
    }).then(async response => {
      if (!response.ok) return null;
      const data = await response.json();
      return data.auction || null;
    }).catch(() => null);
    cache.set(productId, promise);
    return promise;
  };

  const scan = async () => {
    const controls = Array.from(document.querySelectorAll('form[action*="/cart/add"], button[name="add"], input[name="add"], quick-add-component, add-to-cart-component, sticky-add-to-cart, [data-testid*="add-to-cart"], [data-action="add-to-cart"], [data-add-to-cart]'));
    const ids = new Set();
    const unresolved = [];
    for (const control of controls) {
      const id = productIdOf(control);
      if (id) {
        ids.add(id);
      } else {
        const handle = productHandleOf(control);
        if (handle) unresolved.push({ control, handle });
      }
    }
    if (root?.dataset.productId) ids.add(root.dataset.productId);

    for (const item of unresolved) {
      const id = await productIdForHandle(item.handle);
      if (id) ids.add(id);
      item.productId = id;
    }

    for (const id of ids) {
      const auction = await auctionFor(id);
      if (!auction) continue;
      const active = auction.status === "LIVE" || auction.status === "UPCOMING";
      if (!active) continue;
      for (const control of controls) {
        const resolvedId = productIdOf(control) || unresolved.find((item) => item.control === control)?.productId;
        if (resolvedId === id && isPurchaseControl(control)) hide(control);
      }
    }
  };

  let queued = false;
  const scheduleScan = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  };

  scan();
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-product-id", "data-productid", "data-product"] });
  setInterval(() => {
    // Recheck auction state so a newly LIVE/ended auction does not require navigation.
    for (const key of cache.keys()) cache.delete(key);
    scan();
  }, 15000);
})();
