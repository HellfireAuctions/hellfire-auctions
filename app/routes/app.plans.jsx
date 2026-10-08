import { useEffect } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { BILLING_NAMES, PLANS, TRIAL_DAYS, HOT_BID_THRESHOLD } from "../plans.shared";
import { auctionsCreatedThisMonth, planNeedsChoice, setShopPlan, syncShopPlan } from "../plans.server";

export const loader = async ({ request }) => {
  const { billing, admin, session } = await authenticate.admin(request);
  const wasUndecided = await planNeedsChoice(session.shop);
  const { plan, isTest, complimentary } = await syncShopPlan({ billing, admin, shop: session.shop });
  const stillUndecided = await planNeedsChoice(session.shop);
  if (wasUndecided && !stillUndecided) throw redirect("/app"); // a paid plan was just approved: on to the setup guide
  const used = await auctionsCreatedThisMonth(session.shop);
  return {
    needsChoice: stillUndecided,
    current: plan.key,
    used,
    limit: Number.isFinite(plan.monthlyLimit) ? plan.monthlyLimit : null,
    isTest,
    complimentary,
  };
};

export const action = async ({ request }) => {
  const { billing, admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const target = String(form.get("plan") || "");
  const { plan: current, isTest, subscription } = await syncShopPlan({ billing, admin, shop: session.shop });

  if (target === "SPARK") {
    if (subscription?.id) {
      await billing.cancel({ subscriptionId: subscription.id, isTest, prorate: true });
    }
    const wasUndecided = await planNeedsChoice(session.shop);
    await setShopPlan(session.shop, "SPARK", null, { confirm: true });
    if (wasUndecided) return redirect("/app"); // plan chosen: on to the setup guide
    return { message: "You're on Spark (free). You can upgrade again any time." };
  }

  if (!BILLING_NAMES[target] || current.key === target) {
    return { message: "No change needed." };
  }

  const storeHandle = session.shop.replace(".myshopify.com", "");
  // Ask Shopify for the approval link and return it as data. The page then opens it (and shows a
  // button as a fallback), so the upgrade never depends on a redirect that some browsers block.
  const returnUrl = `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/plans`;
  try {
    const response = await admin.graphql(
      `#graphql
        mutation StartPlan($name: String!, $returnUrl: URL!, $trialDays: Int!, $test: Boolean!, $price: Decimal!) {
          appSubscriptionCreate(
            name: $name
            returnUrl: $returnUrl
            trialDays: $trialDays
            test: $test
            lineItems: [{ plan: { appRecurringPricingDetails: { price: { amount: $price, currencyCode: USD }, interval: EVERY_30_DAYS } } }]
          ) {
            confirmationUrl
            userErrors { field message }
          }
        }`,
      {
        variables: {
          name: BILLING_NAMES[target],
          returnUrl,
          trialDays: TRIAL_DAYS,
          test: Boolean(isTest),
          price: String(PLANS[target].price),
        },
      },
    );
    const json = await response.json();
    const result = json?.data?.appSubscriptionCreate;
    if (result?.confirmationUrl) return { confirmationUrl: result.confirmationUrl, plan: target };
    const reason = (result?.userErrors || []).map((e) => e.message).join(", ") || (json?.errors || []).map((e) => e.message).join(", ");
    console.error("[plans] could not start the subscription:", reason);
    return { error: "Shopify couldn't start the upgrade" + (reason ? `: ${reason}` : ".") + " Please try again, or contact support@hellfireauctions.com." };
  } catch (error) {
    console.error("[plans] subscription request failed:", error?.message || error);
    return { error: "Shopify couldn't start the upgrade. Please try again, or contact support@hellfireauctions.com." };
  }
};

const TIERS = [
  {
    key: "SPARK",
    flames: "\u{1F525}",
    tagline: "Light your first fire",
    price: "Free",
    gradient: "linear-gradient(135deg,#3a3a3a 0%,#1c1c1c 100%)",
    accent: "#f5c542",
    perks: [
      "10 auctions every month",
      "Live bidding with automatic proxy bids",
      "Instant bid updates: shoppers see new bids within a second, with no refreshing",
      "Reserve prices, an optional Buy It Now price, scheduling and test auctions",
      "Bid history, bidder blocking, optional bidder rules and a My Auctions page",
      "Square photos, bulk creation from a spreadsheet and auction events",
      "Analytics: sales, share sold, average sale, price uplift and payment speed",
      "A floating Live Auctions button (you can switch it off), in seven languages",
      "Winner invoiced automatically",
      "Works with any Shopify theme",
    ],
  },
  {
    key: "BLAZE",
    flames: "\u{1F525}\u{1F525}",
    tagline: "Turn up the heat",
    price: "$10",
    gradient: "linear-gradient(135deg,#ff7a18 0%,#c2410c 100%)",
    accent: "#fff3c4",
    badge: "MOST POPULAR",
    perks: [
      "90 auctions every month",
      "Everything in Spark",
      "Outbid and \u201C1 hour left\u201D emails to bidders",
      "Watch lists and \u201Cremind me\u201D emails for shoppers",
      "Unpaid-winner reminders and \u201CSorry, you didn't win\u201D emails",
      "\u201CSold\u201D and \u201Cauction ended\u201D summary emails to you",
      `${TRIAL_DAYS}-day free trial`,
    ],
  },
  {
    key: "INFERNO",
    flames: "\u{1F525}\u{1F525}\u{1F525}",
    tagline: "Unleash the inferno",
    price: "$25",
    gradient: "linear-gradient(135deg,#ff1e1e 0%,#7a0000 55%,#1a0000 100%)",
    accent: "#ffd60a",
    badge: "UNLIMITED",
    perks: [
      "Unlimited auctions",
      "Everything in Blaze",
      "Deeper analytics: best times to end auctions, your best buyers, what didn't sell and plain-language advice",
      "Live Drops: sell set-price items live on any stream; the first to tap CLAIM gets it, with one combined invoice per shopper",
      "Optional Anti Sniping: auto-extend on late bids",
      `\u{1F525} HOT flame badge on auctions with ${HOT_BID_THRESHOLD}+ bids`,
      "Priority support",
      `${TRIAL_DAYS}-day free trial`,
    ],
  },
];

export default function Plans() {
  const { current, used, limit, isTest, complimentary, needsChoice } = useLoaderData();
  const navigation = useNavigation();
  const actionData = useActionData();
  useEffect(() => {
    if (actionData?.confirmationUrl) {
      try {
        window.open(actionData.confirmationUrl, "_top");
      } catch {
        // the button below still works
      }
    }
  }, [actionData]);
  const busy = navigation.state !== "idle";
  const currentPlan = PLANS[current] || PLANS.SPARK;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 100;

  return (
    <s-page heading="Hellfire Auctions plans">
      <div style={{ display: "grid", gap: 20 }}>
        {needsChoice && (
          <div style={{ background: "#fff8e1", border: "2px solid #ffd60a", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Step 1 of setup: choose your plan</div>
            <div>Your plan decides which features you get. Spark is free; Blaze and Inferno start with a 7-day free trial. You can change plans any time. When you have chosen, the setup guide opens.</div>
          </div>
        )}
        {actionData?.confirmationUrl && (
          <div style={{ background: "#fff8e1", border: "2px solid #ffd60a", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>One more step: approve your plan on Shopify</div>
            <div style={{ marginBottom: 10 }}>Shopify's approval page should open by itself. If it doesn't, click the button below.</div>
            <a
              href={actionData.confirmationUrl}
              target="_top"
              rel="noopener"
              style={{ display: "inline-block", background: "#ff3b30", color: "#fff", fontWeight: 800, padding: "10px 18px", borderRadius: 8, textDecoration: "none" }}
            >
              Continue to Shopify
            </a>
          </div>
        )}
        {actionData?.error && (
          <div style={{ background: "#fdecea", border: "1px solid #f5c2c0", borderRadius: 12, padding: "12px 16px", color: "#8a1c13" }}>{actionData.error}</div>
        )}
        {actionData?.message && !actionData?.confirmationUrl && (
          <div style={{ background: "#e8f5e9", border: "1px solid #b7dfc9", borderRadius: 12, padding: "12px 16px", color: "#1b5e20" }}>{actionData.message}</div>
        )}
        <div style={{ background: "linear-gradient(90deg,#1a0000,#7a0000,#ff3b30)", color: "#fff", borderRadius: 16, padding: "22px 24px" }}>
          <div style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffd60a", fontWeight: 700 }}>
            {needsChoice ? "Step 1: choose your plan" : "Your plan"}
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, margin: "4px 0 10px" }}>
            {needsChoice ? "Pick the plan that fits you" : `${currentPlan.name}${complimentary ? " (complimentary)" : ""}`}
          </div>
          <div style={{ fontSize: 15, marginBottom: 8 }}>
            {limit ? `${used} of ${limit} auctions used this month` : `${used} auctions this month \u2014 unlimited`}
          </div>
          <div style={{ height: 10, background: "rgba(255,255,255,0.2)", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg,#ffd60a,#ff7a18)" }} />
          </div>
          {isTest && (
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
              Development store: upgrades here are free test charges.
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16 }}>
          {TIERS.map((tier) => {
            const isCurrent = !needsChoice && tier.key === currentPlan.key;
            return (
              <div
                key={tier.key}
                style={{
                  position: "relative",
                  background: tier.gradient,
                  color: "#fff",
                  borderRadius: 18,
                  padding: "26px 22px 22px",
                  boxShadow: isCurrent ? `0 0 0 3px ${tier.accent}, 0 12px 30px rgba(255,59,48,0.35)` : "0 10px 24px rgba(0,0,0,0.25)",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {tier.badge && (
                  <div style={{ position: "absolute", top: 14, right: 14, background: tier.accent, color: "#1a0000", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", padding: "4px 10px", borderRadius: 999 }}>
                    {tier.badge}
                  </div>
                )}
                <div style={{ fontSize: 28 }}>{tier.flames}</div>
                <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{PLANS[tier.key].name}</div>
                <div style={{ color: tier.accent, fontWeight: 600, marginBottom: 12 }}>{tier.tagline}</div>
                <div style={{ fontSize: 40, fontWeight: 900, lineHeight: 1 }}>
                  {tier.price}
                  {tier.key !== "SPARK" && <span style={{ fontSize: 15, fontWeight: 600 }}> /month</span>}
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: "18px 0 22px", display: "grid", gap: 8, flexGrow: 1 }}>
                  {tier.perks.map((perk) => (
                    <li key={perk} style={{ display: "flex", gap: 8, fontSize: 14, lineHeight: 1.4 }}>
                      <span style={{ color: tier.accent, fontWeight: 900 }}>{"\u2713"}</span>
                      <span>{perk}</span>
                    </li>
                  ))}
                </ul>
                {isCurrent ? (
                  <div style={{ textAlign: "center", fontWeight: 800, padding: "12px 0", borderRadius: 10, background: "rgba(255,255,255,0.15)" }}>
                    {"\u2713"} Current plan
                  </div>
                ) : complimentary ? null : (
                  <Form method="post">
                    <input type="hidden" name="plan" value={tier.key} />
                    <button
                      type="submit"
                      disabled={busy}
                      style={{ width: "100%", border: 0, cursor: "pointer", fontWeight: 800, fontSize: 15, padding: "12px 0", borderRadius: 10, background: tier.accent, color: "#1a0000" }}
                    >
                      {tier.key === "SPARK" ? (needsChoice ? "Start with Spark (free)" : "Switch to Spark") : `Ignite ${PLANS[tier.key].name}`}
                    </button>
                  </Form>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 12, color: "#666" }}>
          Billed through Shopify every 30 days. Cancel or change plans any time. Auction limits reset on the 1st of each month.
        </div>
      </div>
    </s-page>
  );
}
