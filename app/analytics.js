// Seller analytics: everything the dashboard shows, calculated from the auctions a store has run. Pure, so it is tested.
// "Sold" means the auction had bids and reached its reserve (if it has one). Test auctions and cancelled auctions are
// never counted, and only auctions that have actually ended are.

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PAY_WINDOW_DAYS = 4;
const MIN_SAMPLE = 3; // a "best time" needs at least this many auctions behind it

const cents = (n) => Math.round(n * 100) / 100;
const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);

export function isSold(a) {
  return Number(a.bidCount) > 0 && (a.reservePrice === null || a.reservePrice === undefined || Number(a.currentBid) >= Number(a.reservePrice));
}

// The calendar day, hour and weekday of a moment as they are in the store's own time zone.
const formatters = new Map(); // creating a formatter is slow, so each time zone's is made once
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(date, timeZone = "UTC") {
  const p = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hour: Number(p.hour) % 24, dow: WEEKDAYS.indexOf(p.weekday) };
}

// The Monday of the week a moment falls in (store time zone), as "YYYY-MM-DD".
export function weekStart(date, timeZone = "UTC") {
  const { y, m, d, dow } = localParts(date, timeZone);
  return new Date(Date.UTC(y, m - 1, d) - ((dow + 6) % 7) * DAY).toISOString().slice(0, 10);
}

function bestOf(slots, label) {
  const eligible = slots.filter((s) => s.ended >= MIN_SAMPLE);
  if (!eligible.length) return null;
  const top = [...eligible].sort((a, b) => b.sellThrough - a.sellThrough || (b.avgPrice || 0) - (a.avgPrice || 0) || b.ended - a.ended)[0];
  return { [label]: top[label], sellThrough: top.sellThrough, avgPrice: top.avgPrice, ended: top.ended };
}

export function computeAnalytics({ auctions, paid = new Map(), now = new Date(), timeZone = "UTC", days = 30 }) {
  const from = new Date(now.getTime() - days * DAY);
  const rows = auctions.filter((a) => !a.isTest && a.status !== "CANCELLED" && new Date(a.endsAt) <= now && new Date(a.endsAt) >= from);
  const sold = rows.filter(isSold);
  const soldIds = new Set(sold.map((a) => a.id));
  const paidDate = (a) => (paid.get(a.id) ? new Date(paid.get(a.id)) : null);

  // ----- totals -----
  const revenue = cents(sold.reduce((s, a) => s + Number(a.currentBid), 0));
  const uplifts = sold.filter((a) => Number(a.startingBid) > 0).map((a) => Number(a.currentBid) / Number(a.startingBid) - 1);
  const mature = sold.filter((a) => now.getTime() - new Date(a.endsAt).getTime() >= PAY_WINDOW_DAYS * DAY);
  const unpaid = sold.filter((a) => !paidDate(a));
  const hoursToPay = sold.map((a) => (paidDate(a) ? (paidDate(a).getTime() - new Date(a.endsAt).getTime()) / 3_600_000 : null)).filter((h) => h !== null && h >= 0);
  const totals = {
    ended: rows.length,
    sold: sold.length,
    unsold: rows.length - sold.length,
    unsoldNoBids: rows.filter((a) => Number(a.bidCount) === 0).length,
    unsoldReserve: rows.filter((a) => Number(a.bidCount) > 0 && !isSold(a)).length,
    sellThrough: rows.length ? sold.length / rows.length : null,
    revenue,
    avgPrice: sold.length ? cents(revenue / sold.length) : null,
    avgBids: sold.length ? cents(sold.reduce((s, a) => s + Number(a.bidCount), 0) / sold.length) : null,
    upliftPct: uplifts.length ? Math.round(mean(uplifts) * 100) : null,
    paidRate: mature.length ? mature.filter((a) => paidDate(a)).length / mature.length : null,
    awaitingPayment: unpaid.length,
    unpaidValue: cents(unpaid.reduce((s, a) => s + Number(a.currentBid), 0)),
    avgHoursToPay: hoursToPay.length ? Math.round(mean(hoursToPay) * 10) / 10 : null,
  };

  // ----- by week, hour of day and day of week (all in the store's own time zone) -----
  const weeks = new Map();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ended: 0, sold: 0, revenue: 0 }));
  const dows = Array.from({ length: 7 }, (_, dow) => ({ dow, name: WEEKDAYS[dow], ended: 0, sold: 0, revenue: 0 }));
  for (const a of rows) {
    const { hour, dow } = localParts(a.endsAt, timeZone);
    const wk = weekStart(a.endsAt, timeZone);
    const w = weeks.get(wk) || { weekStart: wk, ended: 0, sold: 0, revenue: 0 };
    weeks.set(wk, w);
    const isS = soldIds.has(a.id);
    for (const slot of [w, hours[hour], dows[dow]]) {
      slot.ended += 1;
      if (isS) {
        slot.sold += 1;
        slot.revenue += Number(a.currentBid);
      }
    }
  }
  const finish = (slot) => ({ ...slot, revenue: cents(slot.revenue), sellThrough: slot.ended ? slot.sold / slot.ended : null, avgPrice: slot.sold ? cents(slot.revenue / slot.sold) : null });
  const byWeek = [...weeks.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1)).map(finish);
  const byHour = hours.map(finish);
  const byDay = dows.map(finish);

  // ----- who buys -----
  const buyers = new Map();
  for (const a of sold) {
    if (!a.winnerId) continue;
    const b = buyers.get(a.winnerId) || { winnerId: a.winnerId, wins: 0, spent: 0, paid: 0 };
    buyers.set(a.winnerId, b);
    b.wins += 1;
    b.spent += Number(a.currentBid);
    if (paidDate(a)) b.paid += 1;
  }
  const topBuyers = [...buyers.values()].map((b) => ({ ...b, spent: cents(b.spent) })).sort((a, b) => b.spent - a.spent || b.wins - a.wins).slice(0, 10);

  // ----- Buy It Now -----
  const bought = sold.filter((a) => a.buyNowPrice !== null && a.buyNowPrice !== undefined && Number(a.bidCount) === 1 && Number(a.currentBid) === Number(a.buyNowPrice));
  const buyNow = { count: bought.length, revenue: cents(bought.reduce((s, a) => s + Number(a.currentBid), 0)) };

  return {
    period: { days, from: from.toISOString(), to: now.toISOString() },
    totals,
    byWeek,
    byHour,
    byDay,
    bestHour: bestOf(byHour, "hour"),
    bestDay: bestOf(byDay, "dow") && { ...bestOf(byDay, "dow"), name: WEEKDAYS[bestOf(byDay, "dow").dow] },
    topBuyers,
    buyNow,
  };
}

// Plain-language observations from the numbers. Each one is a rule a seller can act on; nothing is invented.
export function insights(a) {
  const t = a.totals;
  const out = [];
  if (t.ended < 5) return out;
  if (t.sellThrough !== null && t.sellThrough < 0.6 && t.unsoldNoBids / t.ended > 0.25) {
    out.push(`${t.unsoldNoBids} of your ${t.ended} auctions got no bids at all. Lower starting bids, better photos or a longer run often fix that.`);
  }
  if (t.unsoldReserve >= 3 && t.unsoldReserve / t.ended > 0.15) {
    out.push(`${t.unsoldReserve} auctions had bids but didn't reach your reserve. A lower reserve (or none) would have turned them into sales.`);
  }
  if (a.bestHour && a.bestHour.sellThrough >= 0.1) {
    out.push(`Auctions ending around ${a.bestHour.hour}:00 sell best (${Math.round(a.bestHour.sellThrough * 100)}% sold). Try ending more of them then.`);
  }
  if (a.bestDay) out.push(`${a.bestDay.name} endings do best (${Math.round(a.bestDay.sellThrough * 100)}% sold).`);
  if (t.paidRate !== null && t.paidRate < 0.85) {
    out.push(`${Math.round((1 - t.paidRate) * 100)}% of sold items older than ${PAY_WINDOW_DAYS} days are still unpaid. Turn on Who can bid rules or keep the automatic block after unpaid sales.`);
  }
  if (t.upliftPct !== null && t.upliftPct >= 100) {
    out.push(`Your items sell for ${t.upliftPct}% above their starting bids on average. Auctions are earning you far more than a fixed price would.`);
  }
  return out;
}
