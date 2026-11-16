// Built-in live video (Go Live): who may use it, and when a stream counts as live. Pure, so it can be tested.

export const MAX_STREAM_MS = 4 * 60 * 60 * 1000; // a stream never runs longer than 4 hours
export const BEAT_WINDOW_MS = 30 * 1000; // the host's Studio page checks in every few seconds; silence for 30 s means the host has left

// Built-in video is part of the top plan (Inferno): the video runs on Cloudflare, which costs per minute streamed and watched.
export const GO_LIVE_PLAN = "INFERNO";
export function goLiveEnabled(planKey) {
  return String(planKey || "").toUpperCase() === GO_LIVE_PLAN;
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
