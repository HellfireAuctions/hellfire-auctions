import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";

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

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop || url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");

  const header = `<div style="max-width:1100px;margin:0 auto;padding:32px 20px 60px">
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
  const ids = myBids.map((b) => b.auctionId);
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

  const now = new Date();
  const rows = auctions.map((a) => {
    const ended = now >= a.endsAt;
    const iLead = leader.get(a.id) === customerId;
    const reserveOk = a.reservePrice == null || Number(a.currentBid) >= Number(a.reservePrice);
    const key = now < a.startsAt ? "UPCOMING" : ended ? (iLead && reserveOk ? "WON" : "LOST") : iLead ? "WINNING" : "OUTBID";
    return { a, ended, key, link: links.get(a.productId) || null };
  });
  // Live auctions first (soonest ending), then ended ones.
  rows.sort((x, y) => Number(x.ended) - Number(y.ended));

  const cards = rows
    .map(({ a, ended, key, link }) => {
      const s = STATUS[key];
      const img = a.imageUrl
        ? `<img src="${esc(a.imageUrl)}" alt="${esc(a.title)}" style="width:100%;aspect-ratio:1/1;object-fit:cover;display:block">`
        : `<div style="aspect-ratio:1/1;background:linear-gradient(135deg,#3d0000,#ff3b30)"></div>`;
      const open = link ? `<a href="${esc(link)}" style="color:inherit;text-decoration:none;display:block">` : "<div>";
      const close = link ? "</a>" : "</div>";
      const action =
        key === "OUTBID" && link
          ? `<a href="${esc(link)}" style="display:block;text-align:center;margin-top:10px;background:#ff3b30;color:#fff;padding:10px;border-radius:8px;text-decoration:none;font-weight:800">Bid again &rarr;</a>`
          : "";
      return `<div style="border:1px solid rgba(0,0,0,.12);border-radius:14px;overflow:hidden;background:#fff;color:#151515;display:flex;flex-direction:column">
        ${open}${img}${close}
        <div style="padding:12px 14px 14px">
          <div style="display:inline-block;background:${s.bg};color:#fff;font-weight:800;font-size:12px;letter-spacing:.06em;padding:4px 10px;border-radius:999px">${s.text}</div>
          <div style="font-weight:700;margin:8px 0 4px">${open}${esc(a.title)}${close}</div>
          <div style="font-size:20px;font-weight:800;color:#d72c0d">${money(a.currentBid)} <span style="font-size:12px;color:#616161;font-weight:500">${ended ? "final" : "current"} &middot; ${a.bidCount} bid${a.bidCount === 1 ? "" : "s"}</span></div>
          <div style="font-size:13px;color:#616161">Your maximum: ${money(myMax.get(a.id))}</div>
          <div style="font-size:13px;color:#303030;margin-top:4px" data-hf-ends="${a.endsAt.toISOString()}">${ended ? "Auction ended" : ""}</div>
          ${action}
        </div>
      </div>`;
    })
    .join("");

  return liquid(`${header}
    <p style="margin:0 0 22px;color:#616161">Every auction you've bid on. This page updates itself.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px">${cards}</div>
  </div>
  <script>
    (function () {
      function tick() {
        document.querySelectorAll("[data-hf-ends]").forEach(function (el) {
          var ms = Date.parse(el.getAttribute("data-hf-ends")) - Date.now();
          if (ms <= 0) { el.textContent = "Auction ended"; return; }
          var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
          el.textContent = (d ? d + "d " : "") + h + "h " + String(m).padStart(2, "0") + "m " + String(sec).padStart(2, "0") + "s left";
        });
      }
      tick(); setInterval(tick, 1000);
      setTimeout(function () { location.reload(); }, 15000);
    })();
  </script>`);
};
