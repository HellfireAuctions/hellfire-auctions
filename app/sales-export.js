// The seller's sales report: one row per auction, ready for Excel or Google Sheets.
// Pure functions so they can be tested without a database.

export const SALES_HEADER = [
  "Auction ID",
  "Title",
  "Status",
  "Started (UTC)",
  "Ended (UTC)",
  "Starting bid",
  "Final price",
  "Bids",
  "Reserve set",
  "Winner customer ID",
  "Paid on (UTC)",
  "Test auction",
];

// A cell that starts with = + - @ would be run as a formula by a spreadsheet, so it gets a leading apostrophe.
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const PAY_WINDOW_MS = 96 * 3600_000;

export function saleStatus(a, paidAt, nowMs) {
  if (a.status === "CANCELLED") return "Cancelled";
  const start = new Date(a.startsAt).getTime();
  const end = new Date(a.endsAt).getTime();
  if (nowMs < start) return "Upcoming";
  if (nowMs < end) return "Live";
  if (a.isTest) return "Test (no sale)";
  if (!a.winnerId) return "Unsold";
  if (paidAt) return "Sold - paid";
  const notified = a.winnerNotifiedAt ? new Date(a.winnerNotifiedAt).getTime() : end;
  return nowMs - notified > PAY_WINDOW_MS ? "Sold - unpaid (deadline passed)" : "Sold - awaiting payment";
}

const iso = (d) => (d ? new Date(d).toISOString() : "");
const price = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "");

export function buildSalesCsv(auctions, paidMap, nowMs = Date.now()) {
  const lines = [SALES_HEADER.map(csvCell).join(",")];
  for (const a of auctions) {
    const paidAt = paidMap.get(a.id);
    const status = saleStatus(a, paidAt, nowMs);
    const sold = status.startsWith("Sold");
    lines.push(
      [
        a.id,
        a.title,
        status,
        iso(a.startsAt),
        iso(a.endsAt),
        price(a.startingBid),
        sold ? price(a.currentBid) : "",
        a.bidCount ?? 0,
        a.reservePrice != null ? "yes" : "no",
        sold ? a.winnerId : "",
        iso(paidAt),
        a.isTest ? "yes" : "no",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n"; // the byte-order mark makes Excel read accents correctly
}
