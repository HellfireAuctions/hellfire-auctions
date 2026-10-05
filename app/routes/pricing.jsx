// Public pricing page for Hellfire Auctions (linked from the App Store listing).
export const meta = () => [
  { title: "Pricing | Hellfire Auctions" },
  { name: "description", content: "Hellfire Auctions plans: Spark (free), Blaze ($10/month) and Inferno ($25/month). Billed through Shopify, cancel anytime." },
];

const S = {
  page: { maxWidth: 980, margin: "0 auto", padding: "40px 22px 70px", fontFamily: "Arial, Helvetica, sans-serif", color: "#1c1c1c", lineHeight: 1.6 },
  hero: { background: "linear-gradient(90deg,#1a0000,#7a0000,#ff3b30)", color: "#fff", borderRadius: 16, padding: "28px 26px", marginBottom: 28 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: 18, margin: "0 0 34px" },
  card: { border: "1px solid #e3e3e3", borderRadius: 16, padding: "22px 20px", background: "#fff" },
  h2: { fontSize: 22, marginTop: 34, marginBottom: 8, color: "#7a0000" },
  price: { fontSize: 34, fontWeight: 800, margin: "4px 0 2px" },
  note: { color: "#616161", fontSize: 14, margin: "0 0 12px" },
  li: { margin: "0 0 8px" },
};

const PLANS = [
  {
    name: "Spark",
    price: "Free",
    sub: "Light your first fire",
    note: "Free forever. No credit card.",
    features: [
      "10 auctions per month",
      "Live bidding with automatic proxy bids",
      "Reserve prices, scheduling and test auctions",
      "Bulk creation from a spreadsheet, weekly repeats and staggered auction events",
      "Automatic relisting of unsold items",
      "Bid history, bidder blocking, optional bidder rules and a My Auctions page",
      "Winner invoiced automatically, with an automatic second chance and blocking for non-payers",
      "A Live Auctions section for your home page (Online Store 2.0 themes)",
      "Spanish storefront and buyer emails",
      "Sales report (CSV) and a full data backup",
      "Works with any Shopify theme",
    ],
  },
  {
    name: "Blaze",
    price: "$10",
    per: "/month",
    sub: "Turn up the heat",
    note: "7-day free trial",
    features: [
      "90 auctions per month",
      "Everything in Spark",
      "Outbid and \u201C1 hour left\u201D emails to bidders",
      "Watch lists and \u201Cremind me\u201D emails for shoppers",
      "Unpaid-winner reminders and \u201Cyou didn't win\u201D emails",
      "\u201CSold\u201D and \u201Cauction ended\u201D summary emails to you",
    ],
  },
  {
    name: "Inferno",
    price: "$25",
    per: "/month",
    sub: "Unleash the inferno",
    note: "7-day free trial",
    features: [
      "Unlimited auctions",
      "Everything in Blaze",
      "Insights: sales, sell-through and top bidders",
      "Anti-sniping option: auto-extend on late bids",
      "HOT flame badge on auctions with 10+ bids",
      "Priority support",
    ],
  },
];

const FAQ = [
  [
    "How am I billed?",
    "Paid plans are billed by Shopify, as a line on your regular Shopify bill, every 30 days. We never ask for a card. Prices are in US dollars.",
  ],
  [
    "Is there a free trial?",
    "Yes. Blaze and Inferno start with a 7-day free trial, and you aren't charged during it. Spark is free and never expires.",
  ],
  [
    "Can I change or cancel my plan?",
    "Any time. Open the app and choose Plans & upgrades. Uninstalling the app also cancels your subscription.",
  ],
  [
    "What counts toward my monthly auction limit?",
    "Each auction you create counts toward the month it was created in, including a relisted auction. Automatic relists, and every auction created from a spreadsheet or a weekly repeat, count too. The 5 and 10-minute test auctions don't count, and on a live store they never create a winner or an invoice. Limits reset on the 1st of each month.",
  ],
  [
    "What happens if I reach my limit?",
    "Auctions already running finish normally and winners are invoiced as usual. You can create new auctions again on the 1st, or right away if you upgrade.",
  ],
  [
    "Do you take a cut of my sales?",
    "No. There are no commissions or transaction fees from us. Your normal Shopify checkout and payment processing fees still apply to what you sell.",
  ],
  [
    "Do I need to set up email or DNS?",
    "No. Auction emails are sent for you, with your store's name, and replies go to your store's contact email. There is nothing to configure.",
  ],
  [
    "Does it work in other languages?",
    "Yes, in English and Spanish. The bidding panel, product-card badges, My Auctions page and buyer emails appear in Spanish when a shopper browses your store in Spanish (emails follow the buyer's own Shopify account language). Other languages show English for now.",
  ],
  [
    "What happens when a winner doesn't pay?",
    "Winners have 4 days to pay, with automatic reminders on Blaze and Inferno. After that the item is offered to the next bidder automatically, the unpaid sale is counted against the first winner, and bidders who reach your limit (2 by default) are blocked from bidding. You can change or switch off all of this in the app.",
  ],
  [
    "Where can I learn more or get help?",
    "Email support@hellfireauctions.com. Our Help center answers the most common questions, and you can also read our Privacy Policy, Terms of Service and Security Policy (all linked below).",
  ],
];

export default function Pricing() {
  return (
    <main style={S.page}>
      <div style={S.hero}>
        <div style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffd60a", fontWeight: 700 }}>Hellfire Auctions</div>
        <h1 style={{ margin: "6px 0 6px", fontSize: 34 }}>Pricing and plans</h1>
        <div>Run live timed auctions in your Shopify store. Start free, upgrade when you need more.</div>
      </div>

      <div style={S.grid}>
        {PLANS.map((p) => (
          <section key={p.name} style={S.card} aria-label={`${p.name} plan`}>
            <h2 style={{ margin: 0, fontSize: 24 }}>{p.name}</h2>
            <div style={{ color: "#c2410c", fontWeight: 700, fontSize: 14 }}>{p.sub}</div>
            <div style={S.price}>
              {p.price}
              {p.per && <span style={{ fontSize: 16, fontWeight: 600, color: "#616161" }}>{p.per}</span>}
            </div>
            <p style={S.note}>{p.note}</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {p.features.map((f) => (
                <li key={f} style={S.li}>{f}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <h2 style={S.h2}>Common questions</h2>
      {FAQ.map(([q, a]) => (
        <div key={q} style={{ margin: "0 0 16px" }}>
          <div style={{ fontWeight: 700 }}>{q}</div>
          <div>{a}</div>
        </div>
      ))}

      <h2 style={S.h2}>More information</h2>
      <p>
        <a href="/help" style={{ color: "#c2410c" }}>Help center</a>{" \u00B7 "}
        <a href="/privacy" style={{ color: "#c2410c" }}>Privacy Policy</a>{" \u00B7 "}
        <a href="/terms" style={{ color: "#c2410c" }}>Terms of Service</a>{" \u00B7 "}
        <a href="/security" style={{ color: "#c2410c" }}>Security Policy</a>{" \u00B7 "}
        <a href="mailto:support@hellfireauctions.com" style={{ color: "#c2410c" }}>support@hellfireauctions.com</a>
      </p>
    </main>
  );
}
