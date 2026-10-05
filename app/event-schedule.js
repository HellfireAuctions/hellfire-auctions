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

// ---------- batches (spreadsheet import): the same wall-clock times, repeated weekly ----------
const pad = (n) => String(n).padStart(2, "0");

function localToMs(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : NaN;
}

// Wall-clock arithmetic on "YYYY-MM-DDTHH:mm": a lot that ends Friday 9:00 PM still ends Friday 9:00 PM next week,
// even when the clocks change in between (the server turns each one into the store's real time).
export function addMinutesLocal(local, minutes) {
  const ms = localToMs(local);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + minutes * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function checkBatchTimes({ count, startLocal, firstEndLocal, gapMinutes, weeks }) {
  if (!count) return "There are no valid rows to create.";
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 8) return "Choose between 1 and 8 weeks.";
  if (count * weeks > 200) return "A batch can create up to 200 auctions at once.";
  if (!Number.isFinite(gapMinutes) || gapMinutes < 1 || gapMinutes > 1440) return "Choose between 1 and 1440 minutes between auction endings.";
  const startMs = localToMs(startLocal);
  const endMs = localToMs(firstEndLocal);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "Choose when the auctions start and when the first one ends.";
  if (endMs - startMs < 60 * 60_000) return "The first auction must end at least 1 hour after the start.";
  return null;
}

// One job per auction to create: lot i of week w.
export function planBatch({ count, startLocal, firstEndLocal, gapMinutes, weeks }) {
  const jobs = [];
  for (let w = 0; w < weeks; w += 1) {
    for (let i = 0; i < count; i += 1) {
      jobs.push({
        index: i,
        week: w,
        startLocal: addMinutesLocal(startLocal, w * 7 * 1440),
        endLocal: addMinutesLocal(firstEndLocal, w * 7 * 1440 + i * gapMinutes),
      });
    }
  }
  return jobs;
}
