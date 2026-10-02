// Public Terms of Service (includes data processing terms) for Hellfire Auctions.
export const meta = () => [{ title: "Terms of Service | Hellfire Auctions" }];

const S = {
  page: { maxWidth: 820, margin: "0 auto", padding: "40px 22px 60px", fontFamily: "Arial, Helvetica, sans-serif", color: "#1c1c1c", lineHeight: 1.6 },
  hero: { background: "linear-gradient(90deg,#1a0000,#7a0000,#ff3b30)", color: "#fff", borderRadius: 16, padding: "28px 26px", marginBottom: 28 },
  h2: { fontSize: 20, marginTop: 30, marginBottom: 8, color: "#7a0000" },
};

export default function Terms() {
  return (
    <main style={S.page}>
      <div style={S.hero}>
        <div style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffd60a", fontWeight: 700 }}>Hellfire Auctions</div>
        <h1 style={{ margin: "6px 0 4px", fontSize: 32 }}>Terms of Service</h1>
        <div>Effective October 2, 2026</div>
      </div>

      <p>These terms apply to every Shopify merchant (&ldquo;you&rdquo;) that installs Hellfire Auctions (&ldquo;the App&rdquo;, &ldquo;we&rdquo;). By installing or using the App you agree to them, together with our <a href="/privacy" style={{ color: "#c2410c" }}>Privacy Policy</a> and <a href="/security" style={{ color: "#c2410c" }}>Security Policy</a>.</p>

      <h2 style={S.h2}>1. The service</h2>
      <p>The App lets you run timed auctions in your Shopify store: creating auction products, accepting bids from signed-in customers, showing live bids and countdowns, emailing bidders on paid plans, and invoicing winners through Shopify draft orders. You are responsible for the items you list, your store&rsquo;s own terms of sale, and fulfilling sold items.</p>

      <h2 style={S.h2}>2. Plans and billing</h2>
      <p>Plans and prices are shown in the App. Paid plans are billed by Shopify every 30 days and can be changed or cancelled at any time from the App. Shopify&rsquo;s billing terms apply to all charges.</p>

      <h2 style={S.h2}>3. Fair auctions</h2>
      <p>Once listed, an auction&rsquo;s starting bid, reserve price, start time and end time cannot be changed, and auctions with bids cannot be cancelled. Bidders&rsquo; maximum bids are kept private from everyone, including you.</p>

      <h2 style={S.h2}>4. Data processing</h2>
      <p>For the personal data of your customers that the App handles, you are the controller and we act as your processor. We:</p>
      <ul>
        <li>process that data only to provide the App&rsquo;s features, as described in our Privacy Policy, and only on your behalf;</li>
        <li>never sell it, use it for advertising, or share it except with the service providers listed in the Privacy Policy (Shopify, Render, Neon, Resend), which are bound to protect it;</li>
        <li>keep it encrypted in transit and at rest, limit access to authorised personnel, and keep access logs;</li>
        <li>delete it when you uninstall the App (after Shopify&rsquo;s data-erasure request) and when Shopify forwards a customer erasure request;</li>
        <li>help you answer customer data requests that Shopify forwards to us; and</li>
        <li>notify you without undue delay, and within 72 hours of becoming aware, of any security incident affecting your data, as described in our Security Policy.</li>
      </ul>

      <h2 style={S.h2}>5. Availability and changes</h2>
      <p>We work to keep the App available and accurate but provide it &ldquo;as is&rdquo; without warranties to the extent the law allows. We may update the App and these terms; material changes will be announced in the App.</p>

      <h2 style={S.h2}>6. Liability</h2>
      <p>To the extent the law allows, our total liability for any claim relating to the App is limited to the fees you paid for the App in the 3 months before the claim.</p>

      <h2 style={S.h2}>7. Ending</h2>
      <p>You can stop using the App at any time by uninstalling it. We may suspend accounts that misuse the App, for example by placing fraudulent bids.</p>

      <h2 style={S.h2}>8. Contact</h2>
      <p><a href="mailto:support@hellfireauctions.com" style={{ color: "#c2410c" }}>support@hellfireauctions.com</a></p>
    </main>
  );
}
