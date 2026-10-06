import { Link, useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopPlan } from "../plans.server";
import { shopCurrency } from "../currency.server";
import { computeAnalytics, insights } from "../analytics";

// Seller analytics: how the store's auctions are really performing. Everyone sees the headline numbers; the deeper
// views (best times to end, top buyers, plain-language advice) are part of the Inferno plan.

const DAY = 86_400_000;
const PERIODS = [30, 90, 365];

async function shopTimezone(admin) {
  try {
    const response = await admin.graphql(`#graphql
      query ShopTimezone { shop { ianaTimezone } }`);
    const tz = (await response.json())?.data?.shop?.ianaTimezone;
    if (tz) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }); // throws if it isn't a real time zone
      return tz;
    }
  } catch {
    /* fall back below */
  }
  return "UTC";
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const asked = Number(new URL(request.url).searchParams.get("days"));
  const days = PERIODS.includes(asked) ? asked : 30;
  const plan = await getShopPlan(shop);
  const timeZone = await shopTimezone(admin);
  const currency = await shopCurrency(shop);
  const now = new Date();
  const auctions = await prisma.auction.findMany({
    where: { shop, isTest: false, status: { not: "CANCELLED" }, endsAt: { gte: new Date(now.getTime() - days * DAY), lte: now } },
    orderBy: { endsAt: "desc" },
    take: 5000,
    select: { id: true, status: true, isTest: true, startingBid: true, currentBid: true, bidCount: true, reservePrice: true, buyNowPrice: true, winnerId: true, endsAt: true },
  });
  const marks = auctions.length
    ? await prisma.auctionNotification.findMany({ where: { type: "PAID", auctionId: { in: auctions.map((a) => a.id) } }, select: { auctionId: true, sentAt: true } })
    : [];
  const result = computeAnalytics({ auctions, paid: new Map(marks.map((m) => [m.auctionId, m.sentAt])), now, timeZone, days });
  const full = plan.key === "INFERNO";
  return {
    days,
    full,
    result,
    tips: full ? insights(result) : [],
    shop,
    timeZone,
    currency: typeof currency === "string" ? currency : currency?.code || "USD",
    truncated: auctions.length >= 5000,
  };
};

const card = { border: "1px solid #d9d9d9", borderRadius: 12, padding: 16, background: "#fff" };
const pct = (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 100)}%`);
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;

function Kpi({ label, value, note }) {
  return (
    <div style={{ ...card, display: "grid", gap: 2 }}>
      <div style={{ fontSize: 13, color: "#616161" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800 }}>{value}</div>
      {note && <div style={{ fontSize: 12, color: "#616161" }}>{note}</div>}
    </div>
  );
}

function Locked({ title }) {
  return (
    <div style={{ ...card, background: "#f6f6f7" }}>
      <strong>{title}</strong>
      <div style={{ fontSize: 14, color: "#616161", margin: "4px 0 8px" }}>This view is part of the Inferno plan.</div>
      <Link to="/app/plans">See plans</Link>
    </div>
  );
}

export default function Analytics() {
  const { days, full, result, tips, shop, currency, truncated, timeZone } = useLoaderData();
  const t = result.totals;
  const money = (v) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(v || 0));
    } catch {
      return `$${Number(v || 0).toFixed(2)}`;
    }
  };
  const handle = shop.replace(".myshopify.com", "");
  const maxWeek = Math.max(1, ...result.byWeek.map((w) => w.revenue));
  const maxHourSold = Math.max(1, ...result.byHour.map((h) => h.ended));

  return (
    <s-page heading="Analytics">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {PERIODS.map((p) => (
          <Link key={p} to={`/app/analytics?days=${p}`} style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid #8a8a8a", textDecoration: "none", background: p === days ? "#303030" : "#fff", color: p === days ? "#fff" : "#303030", fontWeight: 600 }}>
            {p === 365 ? "Last year" : `Last ${p} days`}
          </Link>
        ))}
      </div>
      {truncated && <div style={{ ...card, marginBottom: 12 }}>This period holds more than 5,000 auctions, so only the most recent 5,000 are counted.</div>}

      {t.ended === 0 ? (
        <s-section heading="Nothing to show yet">
          <s-text>No auctions ended in this period. Once auctions have ended (test auctions are never counted), your numbers appear here.</s-text>
        </s-section>
      ) : (
        <>
          <s-section heading="How you're doing">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
              <Kpi label="Sales" value={money(t.revenue)} note={`${t.sold} item${t.sold === 1 ? "" : "s"} sold`} />
              <Kpi label="Sold" value={pct(t.sellThrough)} note={`${t.sold} of ${t.ended} auctions`} />
              <Kpi label="Average sale" value={t.avgPrice === null ? "n/a" : money(t.avgPrice)} note={t.avgBids === null ? "" : `${t.avgBids} bids per sold item`} />
              <Kpi label="Above the starting bid" value={t.upliftPct === null ? "n/a" : `+${t.upliftPct}%`} note="average, on sold items" />
              <Kpi label="Paid" value={pct(t.paidRate)} note={t.awaitingPayment ? `${t.awaitingPayment} awaiting payment (${money(t.unpaidValue)})` : "everything is paid"} />
              <Kpi label="Time to pay" value={t.avgHoursToPay === null ? "n/a" : `${t.avgHoursToPay} h`} note="average, after the auction ends" />
            </div>
          </s-section>

          {full && tips.length > 0 && (
            <s-section heading="What to try">
              <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
                {tips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </s-section>
          )}

          <s-section heading="Sales by week">
            <div style={{ ...card }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 160, overflowX: "auto" }} role="img" aria-label="Sales by week">
                {result.byWeek.map((w) => (
                  <div key={w.weekStart} style={{ flex: "1 0 38px", display: "grid", gap: 4, alignItems: "end", justifyItems: "center" }}>
                    <div style={{ fontSize: 11 }}>{w.revenue ? money(w.revenue) : ""}</div>
                    <div style={{ width: "100%", height: Math.max(2, Math.round((w.revenue / maxWeek) * 110)), background: "#008060", borderRadius: "4px 4px 0 0" }} />
                    <div style={{ fontSize: 11, color: "#616161" }}>{w.weekStart.slice(5)}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "#616161", marginTop: 6 }}>Each bar is a week starting on the Monday shown (month-day).</div>
            </div>
          </s-section>

          {full ? (
            <>
              <s-section heading="Best times to end an auction">
                <div style={{ display: "grid", gap: 14 }}>
                  <div style={card}>
                    <div style={{ fontSize: 13, color: "#616161", marginBottom: 6 }}>
                      Hour of day in your store&rsquo;s time ({timeZone}). Darker means more auctions ended then; the figure is how many of them sold.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 4 }}>
                      {result.byHour.map((h) => (
                        <div key={h.hour} title={`${hourLabel(h.hour)}: ${h.ended} ended, ${h.sold} sold`} style={{ borderRadius: 6, padding: "6px 2px", textAlign: "center", fontSize: 11, background: `rgba(0,128,96,${h.ended ? 0.15 + 0.7 * (h.ended / maxHourSold) : 0.04})`, color: h.ended / maxHourSold > 0.6 ? "#fff" : "#303030" }}>
                          <div>{hourLabel(h.hour)}</div>
                          <div style={{ fontWeight: 700 }}>{h.ended ? `${h.sold}/${h.ended}` : "-"}</div>
                        </div>
                      ))}
                    </div>
                    {result.bestHour && (
                      <div style={{ marginTop: 10, fontWeight: 600 }}>
                        Best hour: {hourLabel(result.bestHour.hour)} ({pct(result.bestHour.sellThrough)} sold, {result.bestHour.ended} auctions)
                      </div>
                    )}
                  </div>
                  <div style={card}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, textAlign: "center" }}>
                      {result.byDay.map((d) => (
                        <div key={d.dow} style={{ border: "1px solid #e3e3e3", borderRadius: 8, padding: 8 }}>
                          <div style={{ fontWeight: 700 }}>{d.name}</div>
                          <div style={{ fontSize: 12 }}>{d.ended ? `${d.sold}/${d.ended} sold` : "-"}</div>
                          <div style={{ fontSize: 12, color: "#616161" }}>{d.revenue ? money(d.revenue) : ""}</div>
                        </div>
                      ))}
                    </div>
                    {result.bestDay && <div style={{ marginTop: 10, fontWeight: 600 }}>Best day: {result.bestDay.name} ({pct(result.bestDay.sellThrough)} sold)</div>}
                  </div>
                </div>
              </s-section>

              <s-section heading="Your best buyers">
                {result.topBuyers.length === 0 ? (
                  <s-text>No winners recorded in this period yet.</s-text>
                ) : (
                  <div style={{ ...card, padding: 0, overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                      <thead>
                        <tr style={{ textAlign: "left", background: "#f6f6f7" }}>
                          <th style={{ padding: 10 }}>Customer</th>
                          <th style={{ padding: 10 }}>Wins</th>
                          <th style={{ padding: 10 }}>Spent</th>
                          <th style={{ padding: 10 }}>Paid</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.topBuyers.map((b) => (
                          <tr key={b.winnerId} style={{ borderTop: "1px solid #e3e3e3" }}>
                            <td style={{ padding: 10 }}>
                              <a href={`https://admin.shopify.com/store/${handle}/customers/${b.winnerId}`} target="_blank" rel="noreferrer">Open customer {String(b.winnerId).slice(-6)}</a>
                            </td>
                            <td style={{ padding: 10 }}>{b.wins}</td>
                            <td style={{ padding: 10 }}>{money(b.spent)}</td>
                            <td style={{ padding: 10 }}>{b.paid} of {b.wins}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </s-section>
            </>
          ) : (
            <s-section heading="Go deeper">
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                <Locked title="Best times to end an auction" />
                <Locked title="Your best buyers" />
                <Locked title="What to try (plain-language advice)" />
              </div>
            </s-section>
          )}

          <s-section heading="What didn't sell">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <Kpi label="Unsold in total" value={String(t.unsold)} note={`of ${t.ended} auctions`} />
              <Kpi label="No bids at all" value={String(t.unsoldNoBids)} note="lower starting bid, better photos" />
              <Kpi label="Bids, but under the reserve" value={String(t.unsoldReserve)} note="a lower reserve would have sold these" />
              {result.buyNow.count > 0 && <Kpi label="Bought with Buy It Now" value={String(result.buyNow.count)} note={money(result.buyNow.revenue)} />}
            </div>
          </s-section>
        </>
      )}
    </s-page>
  );
}
