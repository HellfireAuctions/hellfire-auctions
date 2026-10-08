import prisma from "../db.server";
import { proxyAuth } from "../proxy-auth.server";
import { memo } from "../memo.server";
import { liveStreamUrl, liveHasRoom } from "../live-stream.server";
import { roomView, embedFor } from "../live-sale";
import { shopCurrency, formatMoney } from "../currency.server";

// The live room for a Live Sale, at /apps/hellfire-auctions/live?sale=<id>. Returned as Liquid so Shopify renders it
// inside the store's own theme. "Now selling" is the normal bidding panel for the lot that is live; the page reloads
// itself when the host moves to the next lot. Add &format=json for the room's state as data.

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;");

const liquid = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/liquid" } });
const numeric = (gid) => String(gid || "").split("/").pop();

const LOT_FIELDS = { id: true, productId: true, title: true, imageUrl: true, startingBid: true, currentBid: true, bidCount: true, reservePrice: true, startsAt: true, endsAt: true };

async function loadView(shop, saleId) {
  if (!shop || !saleId) return null;
  const sale = await prisma.liveSale.findFirst({ where: { id: saleId, shop } });
  if (!sale) return null;
  const auctions = sale.lotIds.length ? await prisma.auction.findMany({ where: { shop, id: { in: sale.lotIds } }, select: LOT_FIELDS }) : [];
  const embed = embedFor(sale.videoUrl);
  return { ...roomView({ sale, auctions, now: new Date() }), saleId: sale.id, video: embed ? embed.src : null };
}

function pageHtml(view, streamUrl, money) {
  const thumb = (a) =>
    a.imageUrl
      ? `<img src="${esc(a.imageUrl)}" alt="" loading="lazy" style="width:56px;height:56px;aspect-ratio:1/1;object-fit:cover;border-radius:8px;flex:none">`
      : `<div style="width:56px;height:56px;border-radius:8px;background:rgba(127,127,127,.2);flex:none"></div>`;
  const row = (a, text) => `<div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(127,127,127,.25)">${thumb(a)}<div><div style="font-weight:600">${esc(a.title)}</div><div style="font-size:14px;opacity:.8">${text}</div></div></div>`;
  const chip = { live: "● LIVE NOW", between: "NEXT LOT COMING UP", ended: "SALE ENDED", before: "STARTING SOON" }[view.phase];

  let now;
  if (view.current) {
    now = `<h2 style="margin:0 0 4px;font-size:18px">Lot ${view.lotNumber} of ${view.lotCount}: ${esc(view.current.title)}</h2>
      <div id="hellfire-auction-root" data-product-id="${esc(numeric(view.current.productId))}"></div>`;
  } else if (view.phase === "ended") {
    now = `<p style="font-size:18px;margin:0">This sale has ended. Thank you for joining us!</p>`;
  } else if (view.phase === "between") {
    now = `<p style="font-size:18px;margin:0">The next lot is coming up. Stay on this page: it appears here the moment it goes live.</p>`;
  } else {
    now = `<p style="font-size:18px;margin:0">The sale hasn&rsquo;t started yet. Stay on this page: the first lot appears here the moment it goes live.</p>`;
  }

  const upcoming = view.upcoming.length
    ? `<h2 style="margin:28px 0 4px;font-size:18px">Coming up</h2>${view.upcoming.map((a) => row(a, `Lot ${a.lot}, starting at ${money(a.startingBid)}`)).join("")}`
    : "";
  const done = view.done.length
    ? `<h2 style="margin:28px 0 4px;font-size:18px">Results so far</h2>${[...view.done].reverse().map((a) => row(a, a.sold ? `Lot ${a.lot}, <strong>sold for ${money(a.finalPrice)}</strong>` : `Lot ${a.lot}, not sold`)).join("")}`
    : "";

  const cfg = JSON.stringify({ url: `/apps/hellfire-auctions/live?sale=${view.saleId}&format=json`, version: view.version, stream: streamUrl || "", video: view.video || "", endsAt: view.current ? view.current.endsAt : "" }).replace(/</g, "\\u003c");

  return `<div data-hellfire-no-badges style="max-width:1000px;margin:0 auto;padding:24px 16px 60px">
    <div style="font-size:13px;font-weight:700;letter-spacing:.04em;${view.phase === "live" ? "color:#d72c0d" : "opacity:.7"}">${chip}</div>
    <h1 style="margin:2px 0 16px">${esc(view.title)}</h1>
    ${view.video ? `<div id="hf-live-video" style="position:relative;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;margin-bottom:20px"></div>` : ""}
    <div style="border:1px solid rgba(127,127,127,.35);border-radius:12px;padding:16px">${now}</div>
    ${upcoming}${done}
  </div>
  <script>
  (function () {
    var cfg = ${cfg};
    if (cfg.video) {
      var box = document.getElementById("hf-live-video");
      if (box) {
        var f = document.createElement("iframe");
        f.src = cfg.video.replace("{parent}", encodeURIComponent(location.hostname));
        f.allow = "autoplay; fullscreen; picture-in-picture";
        f.allowFullscreen = true;
        f.title = "Live video";
        f.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
        box.appendChild(f);
      }
    }
    // The bidding panel. The store's page script only loads the panel code on product pages, and it stands down when the
    // panel's container already exists (as it does here), so the room loads the panel code itself. Its address is published
    // on every page by the Hellfire Auctions Runtime embed. Without the embed there is no panel, so say so plainly.
    var root = document.getElementById("hellfire-auction-root");
    if (root) {
      var meta = document.getElementById("hellfire-auction-runtime");
      var panelSrc = meta && meta.getAttribute("data-experience-src");
      if (panelSrc) {
        if (!window.__hellfireAuctionRemount && !document.querySelector("script[data-hellfire-auction-experience]")) {
          var panel = document.createElement("script");
          panel.src = panelSrc;
          panel.defer = true;
          panel.setAttribute("data-hellfire-auction-experience", "true");
          document.head.appendChild(panel);
        }
      } else {
        root.innerHTML = "<p>Bidding is not available on this page yet. The store owner needs to switch on the Hellfire Auctions Runtime app embed (Online Store, Themes, Customize, App embeds).</p>";
      }
    }
    function check() {
      if (document.hidden) return;
      fetch(cfg.url, { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.version && j.version !== cfg.version) location.reload(); })
        .catch(function () {});
    }
    setInterval(check, 4000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
    if (cfg.endsAt) {
      var wait = new Date(cfg.endsAt).getTime() - Date.now() + 2500;
      if (wait > 0) setTimeout(function () { location.reload(); }, wait); // the lot's time is up: show the result
    }
    if (cfg.stream) {
      try {
        var es = new EventSource(cfg.stream);
        es.addEventListener("update", function () { setTimeout(check, 100 + Math.random() * 800); });
      } catch (e) {}
    }
  })();
  </script>`;
}

export const loader = async ({ request }) => {
  const { session } = await proxyAuth(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const saleId = url.searchParams.get("sale") || "";
  const view = await memo("sale:" + saleId, 1000, () => loadView(shop, saleId));

  if (url.searchParams.get("format") === "json") {
    return view ? Response.json(view) : Response.json({ error: "Live sale not found." }, { status: 404 });
  }
  if (!view) {
    return liquid(`<div data-hellfire-no-badges style="max-width:700px;margin:0 auto;padding:40px 16px"><h1>Live sale not found</h1><p>This link isn&rsquo;t valid any more. Check the link you were given.</p></div>`, 404);
  }
  const currency = await shopCurrency(shop);
  const stream = liveHasRoom() ? liveStreamUrl("sale-" + view.saleId, process.env.SHOPIFY_APP_URL || url.origin) : null;
  return liquid(pageHtml(view, stream, (v) => formatMoney(v, currency)));
};
