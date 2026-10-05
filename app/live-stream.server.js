import { subscribe, connectionCount } from "./live-hub.server.js";
import { liveToken, validLiveToken } from "./live-token.js";

// The live connection itself (Server-Sent Events). Shopify's app proxy can't carry a stream, so the shopper's browser
// connects straight to this server with the signed pass from live-token.js. Nothing personal is ever sent on it:
// it only says "something changed", and the page then fetches the details over the normal secure route.
export const MAX_CONNECTIONS = 3000;
const HEARTBEAT_MS = 15_000;
const CORS = { "Access-Control-Allow-Origin": "*" };

export function liveStreamUrl(auctionId, origin, secret = process.env.SHOPIFY_API_SECRET) {
  const token = liveToken(auctionId, secret);
  if (!token || !origin) return null;
  return `${String(origin).replace(/\/$/, "")}/api/stream/${encodeURIComponent(auctionId)}?t=${token}`;
}

export function liveStreamResponse({ auctionId, token, signal, secret = process.env.SHOPIFY_API_SECRET, heartbeatMs = HEARTBEAT_MS, maxConnections = MAX_CONNECTIONS }) {
  if (!validLiveToken(auctionId, token, Date.now(), secret)) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }
  if (connectionCount() >= maxConnections) {
    return new Response("Busy", { status: 503, headers: { ...CORS, "Retry-After": "30" } });
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let done = false;
      let beat = null;
      let unsubscribe = () => {};
      cleanup = () => {
        if (done) return;
        done = true;
        if (beat) clearInterval(beat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const write = (text) => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      write("retry: 3000\n\n");
      send("hello", { at: Date.now() }); // tells the page the connection really works end to end
      unsubscribe = subscribe(auctionId, send);
      beat = setInterval(() => send("ping", { at: Date.now() }), heartbeatMs); // keeps the connection from going quiet
      if (signal) {
        if (signal.aborted) cleanup();
        else signal.addEventListener("abort", cleanup, { once: true });
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform", // no-transform stops the server's compression from holding events back
      "X-Accel-Buffering": "no",
    },
  });
}
