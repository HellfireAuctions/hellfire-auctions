// Cloudflare Stream Live: one private live channel per show. The host sends camera video in (WebRTC "WHIP"), the room
// page plays it back (WebRTC "WHEP"), with well under a second of delay. The secret settings are CLOUDFLARE_ACCOUNT_ID
// and CLOUDFLARE_STREAM_TOKEN; they live only on the server.

const BASE = "https://api.cloudflare.com/client/v4";

export const streamConfigured = (env = process.env) => Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_STREAM_TOKEN);

// Pulls the three things we need out of Cloudflare's answer.
export function parseLiveInput(json) {
  const result = json?.result;
  const uid = result?.uid;
  const publishUrl = result?.webRTC?.url;
  const playUrl = result?.webRTCPlayback?.url;
  if (!uid || !publishUrl || !playUrl) return null;
  return { uid, publishUrl, playUrl };
}

async function call(method, path, body, { fetchImpl = fetch, env = process.env } = {}) {
  if (!streamConfigured(env)) throw new Error("Video is not set up on this server.");
  const response = await fetchImpl(`${BASE}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_STREAM_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* not JSON */
  }
  if (!response.ok || json?.success === false) {
    // never include the token (or anything of ours) in the message
    const detail = (json?.errors || []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare Stream: ${detail}`);
  }
  return json;
}

export async function createLiveInput({ name, ...deps }) {
  const json = await call("POST", "/live_inputs", { meta: { name: String(name || "Live Drops show").slice(0, 100) } }, deps);
  const parsed = parseLiveInput(json);
  if (!parsed) throw new Error("Cloudflare Stream did not return the video addresses.");
  return parsed;
}

export async function deleteLiveInput(uid, deps = {}) {
  if (!uid) return;
  try {
    await call("DELETE", `/live_inputs/${encodeURIComponent(uid)}`, null, deps);
  } catch (error) {
    console.error("[HELLFIRE LIVE DROPS] could not remove the video channel:", uid, error?.message || error);
  }
}
