// Live Sale Mode: the rules. A live sale is a queue of existing auctions ("lots") that the host runs one at a time.
// Starting a lot makes that auction live right now for the sale's lot length; everything after that (bidding, anti-sniping,
// the winner, the invoice) is the normal auction flow. Everything here is pure, so it can be tested without a database.

export const LOT_MIN = 30;
export const LOT_MAX = 600;
export const LOT_DEFAULT = 120;
export const MAX_LOTS = 100;
export const MAX_RUN_SECONDS = 600; // a lot never runs longer than this in one go, whatever the host adds

const ms = (d) => new Date(d).getTime();

export function parseLotSeconds(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return LOT_DEFAULT;
  return Math.min(LOT_MAX, Math.max(LOT_MIN, n));
}

// A pasted video link becomes a safe player address, or null. Only these sites are accepted, over https.
// The Twitch player must be told which site it sits on, so its address holds {parent} for the page to fill in.
export function embedFor(videoUrl) {
  let url;
  try {
    url = new URL(String(videoUrl || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\.|^m\./, "").toLowerCase();
  const idOk = (id) => typeof id === "string" && /^[\w-]{6,20}$/.test(id);

  if (host === "youtube.com" || host === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = host === "youtu.be" ? parts[0] : url.searchParams.get("v") || (["live", "embed", "shorts"].includes(parts[0]) ? parts[1] : null);
    return idOk(id) ? { kind: "youtube", src: `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&rel=0` } : null;
  }
  if (host === "vimeo.com") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return /^\d{5,12}$/.test(id || "") ? { kind: "vimeo", src: `https://player.vimeo.com/video/${id}?autoplay=1&muted=1` } : null;
  }
  if (host === "facebook.com" || host === "fb.watch") {
    return { kind: "facebook", src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url.toString())}&show_text=false&autoplay=true&mute=true` };
  }
  if (host === "twitch.tv") {
    const channel = url.pathname.split("/").filter(Boolean)[0];
    return /^\w{3,25}$/.test(channel || "") ? { kind: "twitch", src: `https://player.twitch.tv/?channel=${channel.toLowerCase()}&parent={parent}&muted=true` } : null;
  }
  return null;
}

const started = (a, now) => a && ms(a.startsAt) <= ms(now);
export const isRunning = (a, now = new Date()) => Boolean(a) && started(a, now) && ms(a.endsAt) > ms(now);

export function startSale(sale) {
  if (sale.status !== "DRAFT") return { ok: false, error: "This sale has already started." };
  if (!sale.lotIds.length) return { ok: false, error: "Add at least one auction to the sale first." };
  return { ok: true, saleUpdate: { status: "LIVE", currentIndex: -1 } };
}

// current: the auction at the sale's current position (or null); next: the auction that would start now.
export function startNextLot({ sale, current, next, now = new Date() }) {
  if (sale.status !== "LIVE") return { ok: false, error: "Start the sale first." };
  if (isRunning(current, now)) return { ok: false, error: "The current lot is still running. End it, or wait for it to finish, first." };
  const index = sale.currentIndex + 1;
  if (index >= sale.lotIds.length) return { ok: true, finished: true, saleUpdate: { status: "ENDED" } };
  if (!next) return { ok: false, error: `Lot ${index + 1} no longer exists. Skip it.`, canSkip: true };
  if (Number(next.bidCount) > 0 || ms(next.startsAt) <= ms(now)) {
    return { ok: false, error: `Lot ${index + 1} has already started or has bids, so it can't be run in the sale. Skip it.`, canSkip: true };
  }
  return {
    ok: true,
    lotNumber: index + 1,
    saleUpdate: { currentIndex: index },
    auctionUpdate: { startsAt: new Date(ms(now)), endsAt: new Date(ms(now) + sale.lotSeconds * 1000) },
  };
}

export function skipLot({ sale, current, now = new Date() }) {
  if (sale.status !== "LIVE") return { ok: false, error: "Start the sale first." };
  if (isRunning(current, now)) return { ok: false, error: "The current lot is still running." };
  const index = sale.currentIndex + 1;
  if (index >= sale.lotIds.length) return { ok: false, error: "There are no more lots to skip." };
  return { ok: true, saleUpdate: { currentIndex: index } };
}

export function extendLot({ current, seconds, now = new Date() }) {
  if (!isRunning(current, now)) return { ok: false, error: "There is no running lot to extend." };
  const add = Math.min(MAX_RUN_SECONDS, Math.max(5, Math.round(Number(seconds)) || 30));
  const left = ms(current.endsAt) - ms(now);
  if (left + add * 1000 > MAX_RUN_SECONDS * 1000) return { ok: false, error: `A lot can run for at most ${MAX_RUN_SECONDS / 60} minutes at a time.` };
  return { ok: true, auctionUpdate: { endsAt: new Date(ms(current.endsAt) + add * 1000) } };
}

export function endLot({ current, now = new Date() }) {
  if (!isRunning(current, now)) return { ok: false, error: "There is no running lot to end." };
  return { ok: true, auctionUpdate: { endsAt: new Date(ms(now)) } };
}

export function endSale({ sale, current, now = new Date() }) {
  if (sale.status === "ENDED") return { ok: false, error: "This sale has already ended." };
  if (isRunning(current, now)) return { ok: false, error: "End the running lot first." };
  return { ok: true, saleUpdate: { status: "ENDED" } };
}

// The public picture of a sale for the live room. No personal data: only what is on the auctions' own pages.
export function roomView({ sale, auctions, now = new Date() }) {
  const byId = new Map(auctions.map((a) => [a.id, a]));
  const lots = sale.lotIds.map((id, i) => ({ index: i, auction: byId.get(id) || null }));
  const current = sale.currentIndex >= 0 ? byId.get(sale.lotIds[sale.currentIndex]) || null : null;
  const running = isRunning(current, now);
  const brief = (a) => ({ id: a.id, productId: a.productId, title: a.title, imageUrl: a.imageUrl || null, startingBid: Number(a.startingBid) });
  const result = (a) => {
    const sold = Number(a.bidCount) > 0 && (a.reservePrice === null || a.reservePrice === undefined || Number(a.currentBid) >= Number(a.reservePrice));
    return { ...brief(a), sold, finalPrice: sold ? Number(a.currentBid) : null, bids: Number(a.bidCount) };
  };
  let phase = "live";
  if (sale.status === "ENDED") phase = "ended";
  else if (sale.status === "DRAFT") phase = "before";
  else if (!running) phase = sale.currentIndex < 0 ? "before" : "between";

  const upcomingFrom = sale.currentIndex + 1;
  return {
    title: sale.title,
    status: sale.status,
    phase,
    lotNumber: sale.currentIndex >= 0 ? sale.currentIndex + 1 : 0,
    lotCount: sale.lotIds.length,
    current: current && running ? { ...brief(current), running, endsAt: new Date(current.endsAt).toISOString(), bids: Number(current.bidCount), currentBid: Number(current.currentBid) } : null,
    upcoming: lots.filter((l) => l.index >= upcomingFrom && l.auction).slice(0, 8).map((l) => ({ ...brief(l.auction), lot: l.index + 1 })),
    done: lots.filter((l) => l.index < upcomingFrom && l.auction && l.auction.id !== (running ? current?.id : null) && ms(l.auction.startsAt) <= ms(now)).slice(-10).map((l) => ({ ...result(l.auction), lot: l.index + 1 })),
    version: `${sale.currentIndex}:${sale.status}:${current ? ms(current.endsAt) : 0}`,
  };
}
