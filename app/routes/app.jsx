import { useEffect } from "react";
import { Outlet, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { isNetworkError, isSessionExpired, mayReauth } from "../network-error";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/live">Live sales</s-link>
        <s-link href="/app/plans">Plans &amp; upgrades</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();
  const dropped = isNetworkError(error);
  const expired = isSessionExpired(error);
  const revalidator = useRevalidator();

  // A 401 means Shopify's login token went missing or expired (an idle admin tab, a refreshed session). Reload once,
  // by itself, to get a fresh one; the guard stops it from ever looping.
  useEffect(() => {
    if (!expired) return undefined;
    let last = null;
    try {
      last = sessionStorage.getItem("hf_reauth");
    } catch {
      /* storage can be unavailable in an embedded frame */
    }
    if (!mayReauth(last)) return undefined;
    try {
      sessionStorage.setItem("hf_reauth", String(Date.now()));
    } catch {
      /* fine */
    }
    const timer = setTimeout(() => window.location.reload(), 1200);
    return () => clearTimeout(timer);
  }, [expired]);

  // A dropped connection (a computer that went to sleep, a wifi blip, a server restart) is not a crash:
  // keep trying quietly and come back by itself as soon as the connection does.
  useEffect(() => {
    if (!dropped) return undefined;
    const retry = setInterval(() => {
      if (navigator.onLine !== false && revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    const back = () => revalidator.revalidate();
    window.addEventListener("online", back);
    return () => {
      clearInterval(retry);
      window.removeEventListener("online", back);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  if (expired) {
    return (
      <div role="status" style={{ maxWidth: 640, margin: "48px auto", padding: "20px 24px", border: "1px solid #e3e3e3", borderRadius: 12, background: "#fff", fontFamily: "Arial, Helvetica, sans-serif" }}>
        <strong style={{ fontSize: 18 }}>Reconnecting to Shopify&hellip;</strong>
        <p style={{ margin: "8px 0 14px" }}>
          Your Shopify session needed a quick refresh. This page reloads by itself in a moment. If you were in the middle of filling something in, it will need to be entered again.
        </p>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #8a8a8a", background: "#f6f6f7", cursor: "pointer" }}>
          Reload now
        </button>
      </div>
    );
  }

  if (dropped) {
    return (
      <div role="status" style={{ maxWidth: 640, margin: "48px auto", padding: "20px 24px", border: "1px solid #e3e3e3", borderRadius: 12, background: "#fff", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.5 }}>
        <strong style={{ fontSize: 18 }}>Reconnecting&hellip;</strong>
        <p style={{ margin: "8px 0 14px" }}>
          The connection to Hellfire Auctions dropped for a moment. This can happen when a computer goes to sleep or the internet blips. Your auctions are safe, and this page will reconnect by itself.
        </p>
        <button type="button" onClick={() => revalidator.revalidate()} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #8a8a8a", background: "#f6f6f7", cursor: "pointer", fontWeight: 600 }}>
          Try again now
        </button>
      </div>
    );
  }
  return boundary.error(error);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
