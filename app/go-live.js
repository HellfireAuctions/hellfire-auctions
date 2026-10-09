// Go Live (beta add-on): who may use it, and when a stream counts as live. Pure, so it can be tested.

export const MAX_STREAM_MS = 4 * 60 * 60 * 1000; // a stream never runs longer than 4 hours
export const BEAT_WINDOW_MS = 30 * 1000; // the host's Studio page checks in every few seconds; silence for 30 s means the host has left

// The add-on switch for now: a list of store addresses in the GOLIVE_SHOPS setting. Billing will replace this later.
export function goLiveShops(value) {
  return new Set(String(value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
export function goLiveEnabled(shop, value) {
  return goLiveShops(value).has(String(shop || "").trim().toLowerCase());
}

// Is the host's video really coming through right now?
export function streamIsLive(sale, now = Date.now()) {
  if (!sale || !sale.streaming || !sale.streamPlayUrl) return false;
  const beat = sale.streamBeatAt ? new Date(sale.streamBeatAt).getTime() : 0;
  const started = sale.streamStartedAt ? new Date(sale.streamStartedAt).getTime() : 0;
  return now - beat <= BEAT_WINDOW_MS && now - started <= MAX_STREAM_MS;
}

// Has a stream outlived its limit (so the video channel should be shut down)?
export function streamExpired(sale, now = Date.now()) {
  return Boolean(sale?.streaming) && Boolean(sale.streamStartedAt) && now - new Date(sale.streamStartedAt).getTime() > MAX_STREAM_MS;
}
