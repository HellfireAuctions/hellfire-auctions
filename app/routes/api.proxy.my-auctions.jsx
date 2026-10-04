import { authenticate, unauthenticated } from "../shopify.server";
import { prefsUrl } from "../prefs.server";
import prisma from "../db.server";
import { shopCurrency, formatMoney } from "../currency.server";
import { getShopPlan, HOT_BID_THRESHOLD } from "../plans.server";

// Customer-facing "My Auctions" page at /apps/hellfire-auctions/my-auctions.
// Returned as Liquid, so Shopify renders it inside the store's own theme (header, footer, fonts).

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;");

const money = (v) => `$${Number(v || 0).toFixed(2)}`;

function liquid(body) {
  return new Response(body, { headers: { "Content-Type": "application/liquid" } });
}

async function productLinks(shop, productIds) {
  const links = new Map();
  if (!productIds.length) return links;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(
      `#graphql
        query MyAuctionProducts($ids: [ID!]!) {
          nodes(ids: $ids) { ... on Product { id handle } }
        }`,
      { variables: { ids: productIds } },
    );
    const json = await response.json();
    for (const node of json?.data?.nodes || []) {
      if (node?.id && node?.handle) links.set(node.id, `/products/${node.handle}`);
    }
  } catch (error) {
    console.error("[my-auctions] product lookup failed:", error?.message || error);
  }
  return links;
}

const STATUS = {
  WINNING: { text: "\u2714 WINNING", bg: "linear-gradient(90deg,#0f8a3c,#19b453)" },
  OUTBID: { text: "\u2716 OUTBID", bg: "linear-gradient(90deg,#b40000,#ff3b30)" },
  WON: { text: "\u{1F3C6} WON", bg: "linear-gradient(90deg,#0f8a3c,#19b453)" },
  LOST: { text: "ENDED", bg: "#3a3a3a" },
  UPCOMING: { text: "UPCOMING", bg: "#b98900" },
};

// Unpaid wins: a Pay now / Pay all wins together banner (statuses cached for 45 seconds).
const unpaidCache = new Map();
async function combineBanner(shop, auctions, customerId, money) {
  const wins = auctions.filter((a) => String(a.winnerId) === String(customerId) && a.winnerDraftOrderId && a.winnerCheckoutUrl);
  if (!wins.length) return "";
  const key = `${shop}|${customerId}|${wins.map((w) => w.id).join(",")}`;
  let hit = unpaidCache.get(key);
  if (!hit || Date.now() - hit.at > 45_000) {
    const statuses = new Map();
    try {
      const { admin } = await unauthenticated.admin(shop);
      const r = await admin.graphql(
        `#graphql
          query DraftStatuses($ids: [ID!]!) { nodes(ids: $ids) { ... on DraftOrder { id status } } }`,
        { variables: { ids: [...new Set(wins.map((w) => w.winnerDraftOrderId))].slice(0, 50) } },
      );
      for (const n of (await r.json())?.data?.nodes || []) if (n?.id) statuses.set(n.id, n.status);
    } catch {
      // no banner if Shopify can't be reached
    }
    hit = { at: Date.now(), statuses };
    if (unpaidCache.size > 500) unpaidCache.clear();
    unpaidCache.set(key, hit);
  }
  const unpaid = wins.filter((w) => ["OPEN", "INVOICE_SENT"].includes(hit.statuses.get(w.winnerDraftOrderId)));
  if (!unpaid.length) return "";
  const total = unpaid.reduce((s, w) => s + Number(w.currentBid || 0), 0);
  const drafts = new Set(unpaid.map((w) => w.winnerDraftOrderId));
  const box = "background:#fff8e1;border:2px solid #ffd60a;border-radius:12px;padding:14px 16px;margin:0 0 22px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between";
  const btn = "background:#ff3b30;color:#fff;font-weight:800;padding:11px 20px;border-radius:8px;border:0;text-decoration:none;cursor:pointer;font-size:15px";
  if (unpaid.length === 1) {
    return `<div style="${box}"><div><strong>You have an unpaid win</strong><br>${esc(unpaid[0].title)} &middot; ${money(unpaid[0].currentBid)}</div><a href="${esc(unpaid[0].winnerCheckoutUrl)}" style="${btn}">Pay now</a></div>`;
  }
  if (drafts.size === 1) {
    return `<div style="${box}"><div><strong>Your ${unpaid.length} wins are on one invoice</strong><br>${money(total)} in total, one shipping charge</div><a href="${esc(unpaid[0].winnerCheckoutUrl)}" style="${btn}">Pay now</a></div>`;
  }
  return `<div style="${box}"><div><strong>You have ${unpaid.length} unpaid wins</strong> (${money(total)})<br>Pay all wins together and pay shipping once.<div id="hf-combine-msg" style="color:#8a1c13;margin-top:4px"></div></div><button id="hf-combine-btn" type="button" style="${btn}">Pay all wins together</button></div>`;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const currency = await shopCurrency(shop);
  const money = (v) => formatMoney(v, currency);
  const customerId = url.searchParams.get("logged_in_customer_id");

  const header = `<div data-hellfire-no-badges style="max-width:1100px;margin:0 auto;padding:32px 20px 60px">
    <h1 style="margin:0 0 6px">My Auctions</h1>`;

  if (!customerId) {
    return liquid(`${header}
      <p>Sign in to see the auctions you're bidding on.</p>
      <p><a href="/account/login?return_url=/apps/hellfire-auctions/my-auctions" style="display:inline-block;background:#151515;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Sign in</a></p>
    </div>`);
  }

  const myBids = await prisma.bid.findMany({
    where: { bidderId: customerId, auction: { shop } },
    select: { auctionId: true, maxBid: true },
  });
  const watched = await prisma.watch.findMany({ where: { customerId, auction: { shop } }, select: { auctionId: true } });
  const ids = [...new Set([...myBids.map((b) => b.auctionId), ...watched.map((w) => w.auctionId)])];
  const auctions = ids.length
    ? await prisma.auction.findMany({ where: { id: { in: ids } }, orderBy: { endsAt: "asc" } })
    : [];

  if (!auctions.length) {
    return liquid(`${header}
      <p>You haven't bid on any auctions yet.</p>
      <p><a href="/collections/live-auctions" style="font-weight:700">Browse live auctions &rarr;</a></p>
    </div>`);
  }

  const allBids = await prisma.bid.findMany({
    where: { auctionId: { in: ids } },
    orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }],
    select: { auctionId: true, bidderId: true },
  });
  const leader = new Map();
  for (const b of allBids) if (!leader.has(b.auctionId)) leader.set(b.auctionId, b.bidderId);
  const myMax = new Map(myBids.map((b) => [b.auctionId, Number(b.maxBid)]));
  const links = await productLinks(shop, [...new Set(auctions.map((a) => a.productId))]);
  const plan = await getShopPlan(shop);

  const now = new Date();
  const rows = auctions.map((a) => {
    const ended = now >= a.endsAt;
    const iLead = leader.get(a.id) === customerId;
    const reserveOk = a.reservePrice == null || Number(a.currentBid) >= Number(a.reservePrice);
    const key = !myMax.has(a.id) ? "WATCHING" : now < a.startsAt ? "UPCOMING" : ended ? (iLead && reserveOk ? "WON" : "LOST") : iLead ? "WINNING" : "OUTBID";
    return { a, ended, key, link: links.get(a.productId) || null };
  });
  // Live auctions first (soonest ending), then ended ones.
  rows.sort((x, y) => Number(x.ended) - Number(y.ended));
  const banner = await combineBanner(shop, auctions, customerId, money);

  // Each card = photo + title + the same black auction box shoppers see on product cards.
  const cards = rows
    .map(({ a, ended, key, link }) => {
      const upcoming = key === "UPCOMING";
      const stateText = upcoming ? "Upcoming auction" : ended ? "Auction ended" : "Live auction";
      const stateKey = upcoming ? "upcoming" : ended ? "ended" : "live";
      const hot = !ended && !upcoming && plan.hotBadge && a.bidCount >= HOT_BID_THRESHOLD;
      const reserveOk = a.reservePrice == null || Number(a.currentBid) >= Number(a.reservePrice);
      const mine = key === "WINNING" ? (reserveOk ? "winning" : "reserve") : key === "OUTBID" ? "outbid" : key === "WON" ? "won" : "";
      const mineText = { winning: "\u2714 WINNING", outbid: "\u2716 OUTBID", won: "\u{1F3C6} WON", reserve: "\u2714 HIGH BIDDER" }[mine] || "";
      const amountLabel = a.bidCount > 0 ? (ended ? "Winning Bid" : "Current Bid") : "Starting Bid";
      const amount = a.bidCount > 0 ? a.currentBid : a.startingBid;
      const bids = `${a.bidCount} bid${a.bidCount === 1 ? "" : "s"}`;
      const timing = ended
        ? ""
        : ` &middot; <span data-hf-ends="${(upcoming ? a.startsAt : a.endsAt).toISOString()}" data-hf-prefix="${upcoming ? "Starts in " : ""}" data-hf-suffix="${upcoming ? "" : " left"}"></span>`;
      const img = a.imageUrl
        ? `<img src="${esc(a.imageUrl)}" alt="${esc(a.title)}" style="width:100%;aspect-ratio:1/1;object-fit:cover;display:block">`
        : `<div style="aspect-ratio:1/1;background:linear-gradient(135deg,#3d0000,#ff3b30)"></div>`;
      const open = link ? `<a href="${esc(link)}" style="color:inherit;text-decoration:none;display:block">` : "<div>";
      const close = link ? "</a>" : "</div>";
      const bidAgain =
        key === "OUTBID" && link
          ? `<a href="${esc(link)}" style="display:block;text-align:center;margin-top:10px;background:#ff3b30;color:#fff;padding:11px;border-radius:8px;text-decoration:none;font-weight:800">Bid again &rarr;</a>`
          : "";
      return `<div>
        ${open}${img}<div style="font-weight:700;margin:10px 0 0">${esc(a.title)}</div>${close}
        <div class="hellfire-card-badge" data-state="${stateKey}" data-hot="${hot}">
          <span class="hellfire-card-badge__top"><span class="hellfire-card-badge__state">${stateText}</span><span class="hellfire-card-badge__hot">${hot ? "\u{1F525} HOT" : ""}</span></span>
          <span class="hellfire-card-badge__mine" data-mine="${mine}">${mineText}</span>
          <span class="hellfire-card-badge__line"><span class="hellfire-card-badge__amount-label">${amountLabel}</span> <strong class="hellfire-card-badge__amount">${money(amount)}</strong></span>
          ${a.reservePrice != null ? `<span class="hellfire-card-badge__reserve" data-reserve="${reserveOk ? "yes" : "no"}">${reserveOk ? "\u2714 Reserve met" : "Reserve not met"}</span>` : ""}
          <span class="hellfire-card-badge__meta">${bids}${timing}</span>
        </div>
        ${bidAgain}
      </div>`;
    })
    .join("");

  return liquid(`${header}
    <p style="margin:0 0 22px;color:#616161">Every auction you've bid on or are watching. This page updates itself. <a href="${esc(prefsUrl(shop, customerId))}" style="color:#616161;font-size:14px">Manage my email notifications</a></p>
    ${banner}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px">${cards}</div>
  </div>
  <script>
    (function () {
      function tick() {
        document.querySelectorAll("[data-hf-ends]").forEach(function (el) {
          var ms = Date.parse(el.getAttribute("data-hf-ends")) - Date.now();
          if (ms <= 0) { el.textContent = "ended"; return; }
          var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
          var txt = d ? d + "d " + h + "h " + String(m).padStart(2, "0") + "m " + String(sec).padStart(2, "0") + "s"
            : h ? h + "h " + String(m).padStart(2, "0") + "m " + String(sec).padStart(2, "0") + "s"
            : m ? m + "m " + String(sec).padStart(2, "0") + "s" : sec + "s";
          el.textContent = (el.getAttribute("data-hf-prefix") || "") + txt + (el.getAttribute("data-hf-suffix") || "");
        });
      }
      var cb = document.getElementById("hf-combine-btn");
      if (cb) cb.addEventListener("click", function () {
        window.__hfBusy = true; cb.disabled = true; cb.textContent = "Preparing your invoice...";
        function fail(msg) {
          document.getElementById("hf-combine-msg").textContent = msg || "Couldn't combine your wins. Please try again.";
          cb.disabled = false; cb.textContent = "Pay all wins together"; window.__hfBusy = false;
        }
        fetch("/apps/hellfire-auctions/combine-invoice", { method: "POST", credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.url) { location.href = j.url; } else { fail(j && j.error); } })
          .catch(function () { fail(); });
      });
      tick(); setInterval(tick, 1000);
      setTimeout(function () { if (!window.__hfBusy) location.reload(); }, 15000);
    })();
  </script>`);
};
