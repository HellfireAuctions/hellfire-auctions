(() => {
  "use strict";

  const PRODUCT_ATTR = "data-hellfire-auction-product";
  const VARIANT_ATTR = "data-hellfire-auction-variant";
  const auctionIds = new Set();
  const auctionHandles = new Set();
  const auctionVariantIds = new Set();
  const productCache = new Map();
  let loading = false;

  const hide = (el) => {
    if (!el || el === document.documentElement) return;
    el.setAttribute(PRODUCT_ATTR, "true");
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
  };

  const normalizeId = (value) => {
    const match = String(value || "").match(/(?:gid:\/\/shopify\/Product\/)?(\d+)/);
    return match ? match[1] : "";
  };

  const normalizeVariantId = (value) => {
    const match = String(value || "").match(/(?:gid:\/\/shopify\/ProductVariant\/)?(\d+)/);
    return match ? match[1] : "";
  };

  const ensureAuctionExperience = async () => {
    const runtimeNode = document.getElementById('hellfire-auction-runtime');
    let productId = normalizeId(runtimeNode?.dataset.productId);
    let variantId = normalizeVariantId(runtimeNode?.dataset.variantId);
    if (!productId) {
      const match = location.pathname.match(/^\/products\/([^/?#]+)/);
      if (match) {
        try {
          const product = await loadProduct(decodeURIComponent(match[1]));
          productId = normalizeId(product.id);
          if (!variantId) variantId = normalizeVariantId(product.variants?.[0]?.id);
        } catch (_) {}
      }
    }
    if (!productId || !auctionIds.has(productId) || document.getElementById('hellfire-auction-root')) return;
    const root = document.createElement('div');
    root.id = 'hellfire-auction-root';
    root.dataset.productId = productId;
    if (variantId) root.dataset.variantId = variantId;
    const form = [...document.querySelectorAll("form[action*='/cart/add']")].find((candidate) => {
      const field = candidate.querySelector("input[name='id'], select[name='id']");
      return normalizeVariantId(field?.value) === variantId;
    });
    if (form?.parentElement) form.parentElement.insertBefore(root, form);
    else (document.querySelector('main') || document.body).appendChild(root);
    const src = runtimeNode?.dataset.experienceSrc;
    if (src && !document.querySelector('script[data-hellfire-auction-experience]')) {
      const script = document.createElement('script');
      script.src = src;
      script.defer = true;
      script.dataset.hellfireAuctionExperience = 'true';
      document.head.appendChild(script);
    }
  };
    const productHandleFromHref = (href) => {
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return "";
      const match = url.pathname.match(/^\/products\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : "";
    } catch (_) {
      return "";
    }
  };

  const productIdFromElement = (el) => {
    let node = el;
    for (let depth = 0; node && node !== document && depth < 12; depth++, node = node.parentElement) {
      const id = normalizeId(
        node.getAttribute?.("data-product-id") ||
        node.getAttribute?.("data-product") ||
        node.getAttribute?.("product-id"),
      );
      if (id) return id;
    }
    return "";
  };

  const variantIdFromElement = (el) => {
    let node = el;
    for (let depth = 0; node && node !== document && depth < 12; depth++, node = node.parentElement) {
      const direct = normalizeVariantId(
        node.getAttribute?.("data-variant-id") ||
        node.getAttribute?.("data-current-variant-id"),
      );
      if (direct) return direct;

      const field = node.querySelector?.("form[action*='/cart/add'] input[name='id'], form[action*='/cart/add'] select[name='id']");
      const fieldId = normalizeVariantId(field?.value);
      if (fieldId) return fieldId;
    }
    return "";
  };

  const purchaseControls = (scope) => scope.querySelectorAll([
    "form[action*='/cart/add']",
    "button[name='add']",
    "button[type='submit'][name='add']",
    "button[data-testid*='add-to-cart']",
    "button[data-action='add-to-cart']",
    "[data-add-to-cart]",
    "[data-add-to-cart-button]",
    "[data-quick-add]",
    "quick-add-component",
    "add-to-cart-component",
    "sticky-add-to-cart",
  ].join(","));

  const hideVariantPurchaseControls = () => {
    document.querySelectorAll("form[action*='/cart/add']").forEach((form) => {
      const field = form.querySelector("input[name='id'], select[name='id']");
      const variantId = normalizeVariantId(field?.value);
      if (!variantId || !auctionVariantIds.has(variantId)) return;
      hide(form);
    });

    document.querySelectorAll("[data-variant-id], [data-current-variant-id]").forEach((el) => {
      const variantId = normalizeVariantId(
        el.getAttribute("data-variant-id") || el.getAttribute("data-current-variant-id"),
      );
      if (variantId && auctionVariantIds.has(variantId)) hide(el);
    });
  };

  const hideProductScopes = () => {
    document.querySelectorAll("a[href*='/products/']").forEach((link) => {
      const handle = productHandleFromHref(link.href);
      if (!handle || !auctionHandles.has(handle)) return;

      let node = link;
      for (let depth = 0; node && node !== document && depth < 10; depth++, node = node.parentElement) {
        const controls = purchaseControls(node);
        if (controls.length) {
          controls.forEach(hide);
          node.setAttribute(PRODUCT_ATTR, "true");
          break;
        }
      }
    });
  };

  const hideKnownProductControls = () => {
    document.querySelectorAll("[data-product-id], [data-product], [product-id]").forEach((el) => {
      const id = productIdFromElement(el);
      if (id && auctionIds.has(id)) {
        const controls = purchaseControls(el);
        controls.forEach(hide);
      }
    });
  };

  const apply = () => {
    hideVariantPurchaseControls();
    hideProductScopes();
    hideKnownProductControls();
  };

  const loadProduct = async (handle) => {
    if (productCache.has(handle)) return productCache.get(handle);
    const promise = fetch("/products/" + encodeURIComponent(handle) + ".js", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    }).then((response) => {
      if (!response.ok) throw new Error("product lookup failed");
      return response.json();
    });
    productCache.set(handle, promise);
    return promise;
  };

  const discoverAuctionProducts = async () => {
    const links = new Map();

    document.querySelectorAll("a[href*='/products/']").forEach((link) => {
      const handle = productHandleFromHref(link.href);
      if (handle) links.set(handle, link);
    });

    await Promise.all([...links.keys()].map(async (handle) => {
      if (auctionHandles.has(handle)) return;
      try {
        const product = await loadProduct(handle);
        const id = normalizeId(product.id);
        if (!id || !auctionIds.has(id)) return;

        auctionHandles.add(handle);
        for (const variant of product.variants || []) {
          const variantId = normalizeVariantId(variant.id);
          if (variantId) auctionVariantIds.add(variantId);
        }
      } catch (_) {
        // Retry through the normal mutation/interval cycle.
      }
    }));

    apply();
  };

  const loadAuctionIds = async () => {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch("/apps/hellfire-auctions/auction-products", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("auction product lookup failed");

      const data = await response.json();
      auctionIds.clear();
      for (const id of data.auctionProductIds || []) {
        const normalized = normalizeId(id);
        if (normalized) auctionIds.add(normalized);
      }

      await discoverAuctionProducts();
      await ensureAuctionExperience();
    } catch (_) {
      // Keep retrying; storefront themes can load asynchronously.
    } finally {
      loading = false;
    }
  };

  // Block purchase activation even if a theme injects its control after our scan.
  document.addEventListener("click", (event) => {
    let node = event.target;
    for (let depth = 0; node && node !== document && depth < 12; depth++, node = node.parentElement) {
      const handle = productHandleFromHref(node.closest?.("a[href*='/products/']")?.href || "");
      if (handle && auctionHandles.has(handle)) {
        const tag = node.tagName?.toLowerCase();
        const text = node.textContent?.trim().toLowerCase() || "";
        if (
          tag === "button" ||
          tag === "input" ||
          node.matches?.("quick-add-component, add-to-cart-component, sticky-add-to-cart, form[action*='/cart/add']")
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (/add to cart|buy now|purchase/.test(text)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
    }
  }, true);

  apply();
  ensureAuctionExperience();
  loadAuctionIds();

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
      discoverAuctionProducts();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-product-id",
      "data-product",
      "product-id",
      "data-variant-id",
      "data-current-variant-id",
    ],
  });

  setInterval(loadAuctionIds, 10000);
  setInterval(apply, 2000);
})();
