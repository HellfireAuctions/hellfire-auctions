import { Form, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { BILLING_NAMES, PLANS, TRIAL_DAYS, HOT_BID_THRESHOLD } from "../plans.shared";
import { auctionsCreatedThisMonth, setShopPlan, syncShopPlan } from "../plans.server";

export const loader = async ({ request }) => {
  const { billing, admin, session } = await authenticate.admin(request);
  const { plan, isTest, complimentary } = await syncShopPlan({ billing, admin, shop: session.shop });
  const used = await auctionsCreatedThisMonth(session.shop);
  return {
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
    await setShopPlan(session.shop, "SPARK", null);
    return { message: "You're on Spark (free). You can upgrade again any time." };
  }

  if (!BILLING_NAMES[target] || current.key === target) {
    return { message: "No change needed." };
  }

  const storeHandle = session.shop.replace(".myshopify.com", "");
  // Sends the merchant to Shopify's approval screen; Shopify brings them back here afterwards.
  return billing.request({
    plan: BILLING_NAMES[target],
    isTest,
    returnUrl: `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/plans`,
  });
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
      "Live countdown on every product card",
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
      "\u201CYou've been outbid\u201D emails bring bidders straight back",
      "\u201C1 hour left\u201D reminder emails to every bidder",
      "Your brand only \u2014 no \u201CPowered by\u201D line",
      `${TRIAL_DAYS}-day free trial`,
    ],
  },
  {
    key: "INFERNO",
    flames: "\u{1F525}\u{1F525}\u{1F525}",
    tagline: "Unleash the inferno",
    price: "$30",
    gradient: "linear-gradient(135deg,#ff1e1e 0%,#7a0000 55%,#1a0000 100%)",
    accent: "#ffd60a",
    badge: "UNLIMITED",
    perks: [
      "Unlimited auctions",
      "Everything in Blaze",
      `\u{1F525} HOT flame badge on auctions with ${HOT_BID_THRESHOLD}+ bids`,
      "Priority support",
      `${TRIAL_DAYS}-day free trial`,
    ],
  },
];

export default function Plans() {
  const { current, used, limit, isTest, complimentary } = useLoaderData();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const currentPlan = PLANS[current] || PLANS.SPARK;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 100;

  return (
    <s-page heading="Hellfire Auctions plans">
      <div style={{ display: "grid", gap: 20 }}>
        <div style={{ background: "linear-gradient(90deg,#1a0000,#7a0000,#ff3b30)", color: "#fff", borderRadius: 16, padding: "22px 24px" }}>
          <div style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffd60a", fontWeight: 700 }}>
            Your plan
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, margin: "4px 0 10px" }}>
            {currentPlan.name} {complimentary ? "(complimentary)" : ""}
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
            const isCurrent = tier.key === currentPlan.key;
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
                      {tier.key === "SPARK" ? "Switch to Spark" : `Ignite ${PLANS[tier.key].name}`}
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
