"use strict";
(() => {
  const PRODUCT_MARK = "data-hellfire-auction-product";
  const ids = new Set(), handles = new Set(), variants = new Set();
  const productCache = new Map(), cardData = new Map();
  const runtime = document.getElementById("hellfire-auction-runtime");
  let loading = false;

  const productId = (v) => String(v || "").match(/(?:gid:\/\/shopify\/Product\/)?(\d+)/)?.[1] || "";
  const variantId = (v) => String(v || "").match(/(?:gid:\/\/shopify\/ProductVariant\/)?(\d+)/)?.[1] || "";
  const productHandle = (href) => {
    try { const u = new URL(href, location.origin); const m = u.pathname.match(/^\/products\/([^/?#]+)/); return m ? decodeURIComponent(m[1]) : ""; }
    catch { return ""; }
  };
  const visible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const hide = (el) => {
    if (!el || el === document.documentElement || el.id === "hellfire-auction-root") return;
    el.setAttribute(PRODUCT_MARK, "true");
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
  };
  const cartSelectors = [
    "form[action*='/cart/add']","button[name='add']","button[type='submit'][name='add']",
    "button[data-testid*='add-to-cart']","button[data-action='add-to-cart']","[data-add-to-cart]",
    "[data-add-to-cart-button]","[data-quick-add]","quick-add-component","add-to-cart-component","sticky-add-to-cart"
  ].join(",");
  const suppressProductCart = () => {
    if (runtime?.dataset.auctionProduct !== "true") return;
    document.querySelectorAll("form[action*='/cart/add']").forEach(hide);
    document.querySelectorAll(cartSelectors).forEach(hide);
  };
  const suppressKnownAuctionCards = () => {
    document.querySelectorAll("form[action*='/cart/add']").forEach((form) => {
      const input = form.querySelector("input[name='id'],select[name='id']");
      const id = variantId(input?.value);
      if (id && variants.has(id)) hide(form);
    });
    handles.forEach((handle) => {
      const link = document.querySelector("a[href*='/products/" + handle + "']");
      if (!link) return;
      const card = cardContainer(link);
      if (!card) return;
      card.querySelectorAll(cartSelectors).forEach(hide);
    });
  };
  const productJson = async (handle) => {
    if (productCache.has(handle)) return productCache.get(handle);
    const promise = fetch("/products/" + encodeURIComponent(handle) + ".js", {
      credentials:"same-origin", cache:"no-store", headers:{Accept:"application/json"}
    }).then((r) => { if (!r.ok) throw new Error("product lookup failed"); return r.json(); });
    productCache.set(handle, promise);
    return promise;
  };
  const discoverProducts = async () => {
    const links = new Map();
    document.querySelectorAll("a[href*='/products/']").forEach((a) => {
      const h = productHandle(a.href); if (h) links.set(h, a);
    });
    await Promise.all([...links.keys()].map(async (h) => {
      if (handles.has(h)) return;
      try {
        const p = await productJson(h), id = productId(p.id);
        if (!id || !ids.has(id)) return;
        handles.add(h);
        if (cardData.has(id)) cardData.set(h, cardData.get(id));
        (p.variants || []).forEach((v) => { const id = variantId(v.id); if (id) variants.add(id); });
      } catch {}
    }));
    suppressKnownAuctionCards();
    renderAuctionCards();
  };
  const cardContainer = (link) => {
    let node = link;
    let best = null;
    for (let depth = 0; node && node !== document.body && depth < 12; depth += 1, node = node.parentElement) {
      const productLinks = [...node.querySelectorAll("a[href*='/products/']")];
      const handlesInNode = new Set(productLinks.map((a) => productHandle(a.href)).filter(Boolean));
      const rect = node.getBoundingClientRect?.();
      if (handlesInNode.size === 1 && rect && rect.width > 120 && rect.height > 80) {
        best = node;
        const parent = node.parentElement;
        const parentLinks = parent ? [...parent.querySelectorAll("a[href*='/products/']")] : [];
        const parentHandles = new Set(parentLinks.map((a) => productHandle(a.href)).filter(Boolean));
        if (!parent || parentHandles.size > 1) break;
      }
    }
    return best || link.parentElement || link;
  };
  const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 0, maximumFractionDigits: 2
  });
  const remaining = (endsAt, startsAt, status) => {
    const end = new Date(endsAt).getTime(), start = new Date(startsAt).getTime(), now = Date.now();
    if (status === "ENDED" || now >= end) return "ENDED";
    if (status === "UPCOMING" || now < start) return "STARTING SOON";
    let seconds = Math.max(0, Math.floor((end - now) / 1000));
    const d = Math.floor(seconds / 86400); seconds %= 86400;
    const h = Math.floor(seconds / 3600); seconds %= 3600;
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return d ? d + "d " + h + "h " + m + "m" : h ? h + "h " + m + "m" : m + "m " + s + "s";
  };
  const updateCard = (panel, data) => {
    panel.querySelector(".hellfire-auction-card-status").textContent =
      data.status === "LIVE" ? "🔥 LIVE AUCTION" : data.status === "UPCOMING" ? "⏳ STARTING SOON" : "AUCTION ENDED";
    panel.querySelector(".hellfire-auction-card-bid").textContent = money(data.currentBid);
    panel.querySelector(".hellfire-auction-card-bids").textContent = (data.bidCount || 0) + " Bids";
    panel.querySelector(".hellfire-auction-card-time").textContent = remaining(data.endsAt, data.startsAt, data.status);
  };
  const renderAuctionCards = () => {
    document.querySelectorAll("a[href*='/products/']").forEach((link) => {
      const handle = productHandle(link.href);
      const data = cardData.get(handle) || cardData.get(findProductId(link));
      if (!data || !ids.has(data.productId)) return;
      const card = cardContainer(link);
      if (!card || card === document.body) return;
      let panel = card.querySelector(":scope > .hellfire-auction-card-summary");
      if (!panel) {
        panel = document.createElement("div");
        panel.className = "hellfire-auction-card-summary";
        panel.innerHTML =
          '<div class="hellfire-auction-card-status"></div>' +
          '<div class="hellfire-auction-card-row"><strong class="hellfire-auction-card-bid"></strong>' +
          '<span class="hellfire-auction-card-bids"></span></div><div class="hellfire-auction-card-time"></div>';
        card.appendChild(panel);
      }
      updateCard(panel, data);
    });
  };
  const findProductId = (el) => {
    for (let n = el, i = 0; n && n !== document && i < 12; i++, n = n.parentElement) {
      const id = productId(n.getAttribute?.("data-product-id") || n.getAttribute?.("data-product") || n.getAttribute?.("product-id"));
      if (id) return id;
    }
    return "";
  };
  const loadCardData = async () => {
    if (loading) return;
    loading = true;
    try {
      const r = await fetch("/apps/hellfire-auctions/auction-card-data", {
        credentials:"same-origin", cache:"no-store", headers:{Accept:"application/json"}
      });
      if (!r.ok) throw new Error("auction card data failed");
      const json = await r.json();
      cardData.clear();
      (json.auctions || []).forEach((a) => {
        const id = productId(a.productId);
        if (id) cardData.set(id, {...a, productId:id});
      });
      for (const [handle, promise] of productCache) {
        promise.then((p) => {
          const id = productId(p.id);
          if (id && cardData.has(id)) cardData.set(handle, cardData.get(id));
        }).catch(() => {});
      }
      renderAuctionCards();
    } catch {} finally { loading = false; }
  };
  const mountAuction = async () => {
    const root = document.getElementById("hellfire-auction-root");
    if (root) return;
    const el = document.getElementById("hellfire-auction-runtime");
    if (!el || !document.body) return;
    let id = productId(el.dataset.productId), variant = variantId(el.dataset.variantId);
    const m = location.pathname.match(/^\/products\/([^/?#]+)/);
    if (!id && m) {
      try { const p = await productJson(decodeURIComponent(m[1])); id = productId(p.id); variant = variantId(p.variants?.[0]?.id); } catch {}
    }
    if (!id || (!ids.has(id) && el.dataset.auctionProduct !== "true")) return;
    el.dataset.auctionProduct = "true"; el.dataset.productId = id;
    if (variant) el.dataset.variantId = variant;
    const form = [...document.querySelectorAll("form[action*='/cart/add']")].find(
      (f) => variantId(f.querySelector("input[name='id'],select[name='id']")?.value) === variant
    );
    const n = document.createElement("div");
    n.id = "hellfire-auction-root"; n.dataset.productId = id;
    if (variant) n.dataset.variantId = variant;
    if (form) {
      let p = form;
      if (!visible(p)) for (;p.parentElement && p !== document.body && !visible(p);) p = p.parentElement;
      p.parentElement?.insertBefore(n, p);
    }
    if (!n.parentElement) {
      const main = document.querySelector("main") || document.body;
      main.insertBefore(n, main.firstChild);
    }
    const src = el.dataset.experienceSrc;
    if (src && !document.querySelector("script[data-hellfire-auction-experience]")) {
      const s = document.createElement("script");
      s.src = src; s.defer = true; s.dataset.hellfireAuctionExperience = "true";
      document.head.appendChild(s);
    }
  };
  const protectClicks = (e) => {
    const el = document.getElementById("hellfire-auction-runtime");
    if (el?.dataset.auctionProduct === "true" && e.target?.closest?.(cartSelectors)) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    let n = e.target;
    for (let i=0;n && n!==document && i<12;i++,n=n.parentElement) {
      const h = productHandle(n.closest?.("a[href*='/products/']")?.href || "");
      if (h && handles.has(h)) {
        const text = n.textContent?.trim().toLowerCase() || "";
        if (n.matches?.(cartSelectors) || /add to cart|buy now|purchase/.test(text)) {
          e.preventDefault(); e.stopImmediatePropagation(); return;
        }
      }
    }
  };
  const boot = async () => {
    // Product pages must mount immediately; auction discovery must never block the storefront.
    await mountAuction();
    suppressProductCart();
    suppressKnownAuctionCards();
    renderAuctionCards();

    void loadCardData();

    void (async () => {
      const response = await fetch("/apps/hellfire-auctions/auction-products", {
        credentials:"same-origin", cache:"no-store", headers:{Accept:"application/json"}
      }).catch(() => null);
      if (response?.ok) {
        const json = await response.json();
        ids.clear();
        (json.auctionProductIds || []).forEach((id) => {
          const n = productId(id);
          if (n) ids.add(n);
        });
      }
      await discoverProducts();
      suppressProductCart();
      suppressKnownAuctionCards();
      renderAuctionCards();
      await mountAuction();
    })();
  };
  document.addEventListener("click", protectClicks, true);
  boot();

  // Adapt to Shopify section/AJAX rerenders without watching attributes or creating
  // a feedback loop from our own auction-card DOM mutations.
  let mutationQueued = false;
  const queueThemeRefresh = () => {
    if (mutationQueued) return;
    mutationQueued = true;
    requestAnimationFrame(() => {
      mutationQueued = false;
      suppressProductCart();
      suppressKnownAuctionCards();
      if (!document.getElementById("hellfire-auction-root")) void mountAuction();
      renderAuctionCards();
    });
  };
  new MutationObserver((records) => {
    const relevant = records.some((record) => {
      if (record.removedNodes.length) return true;
      return [...record.addedNodes].some((node) =>
        node.nodeType === 1 &&
        !node.matches?.(".hellfire-auction-card-summary") &&
        !node.closest?.(".hellfire-auction-card-summary")
      );
    });
    if (relevant) queueThemeRefresh();
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(() => {
    void loadCardData();
    suppressProductCart();
    suppressKnownAuctionCards();
    if (!document.getElementById("hellfire-auction-root")) void mountAuction();
    renderAuctionCards();
  }, 10000);
})();