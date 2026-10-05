import { liveStreamResponse } from "../live-stream.server";

// Live connection for one auction (see live-stream.server.js). Not behind Shopify's app proxy: the browser connects
// directly, and the signed pass in ?t= is the only credential.
export const loader = ({ request, params }) =>
  liveStreamResponse({
    auctionId: params.auctionId,
    token: new URL(request.url).searchParams.get("t") || "",
    signal: request.signal,
  });
