// Rules for scheduling an auction event: several upcoming auctions that end one after another.
// Times arrive as "YYYY-MM-DDTHH:mm" (a datetime-local value) meaning the store's own time zone.

export function parseStoreLocal(value) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!m) return null;
  const h = Number(m[2]);
  if (h > 23 || Number(m[3]) > 59) return null;
  return { date: m[1], hour: String(h % 12 === 0 ? 12 : h % 12), minute: m[3], ampm: h >= 12 ? "PM" : "AM" };
}

// The i-th auction ends i * gap minutes after the first one.
export function staggeredEnds(firstEndMs, gapMinutes, count) {
  return Array.from({ length: count }, (_, i) => new Date(firstEndMs + i * gapMinutes * 60_000));
}

// Returns an error sentence for the seller, or null when the plan is fine.
export function validateEvent({ count, gapMinutes, startMs, firstEndMs, nowMs }) {
  if (!count) return "Choose at least one upcoming auction for the event.";
  if (count > 100) return "An event can have up to 100 auctions.";
  if (!Number.isFinite(gapMinutes) || gapMinutes < 1 || gapMinutes > 1440) return "Choose between 1 and 1440 minutes between auction endings.";
  if (!Number.isFinite(startMs) || !Number.isFinite(firstEndMs)) return "Choose when the event starts and when the first auction ends.";
  if (startMs < nowMs - 5 * 60_000) return "That start time has already passed. Choose a time in the future.";
  const effectiveStart = Math.max(startMs, nowMs);
  if (firstEndMs < effectiveStart + 60 * 60_000) return "The first auction must end at least 1 hour after the event starts.";
  return null;
}
