// Public privacy policy for Hellfire Auctions (no login required).
export const meta = () => [{ title: "Privacy Policy | Hellfire Auctions" }];

const S = {
  page: { maxWidth: 820, margin: "0 auto", padding: "40px 22px 60px", fontFamily: "Arial, Helvetica, sans-serif", color: "#1c1c1c", lineHeight: 1.6 },
  hero: { background: "linear-gradient(90deg,#1a0000,#7a0000,#ff3b30)", color: "#fff", borderRadius: 16, padding: "28px 26px", marginBottom: 28 },
  h2: { fontSize: 20, marginTop: 30, marginBottom: 8, color: "#7a0000" },
};

export default function Privacy() {
  return (
    <main style={S.page}>
      <div style={S.hero}>
        <div style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffd60a", fontWeight: 700 }}>Hellfire Auctions</div>
        <h1 style={{ margin: "6px 0 4px", fontSize: 32 }}>Privacy Policy</h1>
        <div>Effective October 2, 2026</div>
      </div>

      <p>
        Hellfire Auctions (&ldquo;the App&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) is a Shopify app that lets merchants run timed,
        eBay-style auctions in their Shopify stores. This policy explains what information the App collects, why, how it is used,
        who it is shared with, and how it is deleted.
      </p>

      <h2 style={S.h2}>1. Information we collect from merchants</h2>
      <p>When a merchant installs the App, Shopify gives us access to certain store data. We store or use:</p>
      <ul>
        <li>The store&rsquo;s Shopify domain and the access credentials Shopify issues to the App, so the App can work in that store.</li>
        <li>Auction details the merchant enters: title, description, image, starting bid, reserve price, start and end times.</li>
        <li>Product information for auction items the App creates in the store.</li>
        <li>The store&rsquo;s name, time zone and contact email, read from Shopify when needed to display times and to set the reply-to address on bidder emails.</li>
        <li>The store&rsquo;s Hellfire Auctions plan. Payments are handled entirely by Shopify; we never see card details.</li>
      </ul>

      <h2 style={S.h2}>2. Information we collect about bidders (the merchant&rsquo;s customers)</h2>
      <ul>
        <li>The bidder&rsquo;s Shopify customer ID, their bid amounts, their maximum bid, and the time of each bid.</li>
        <li>
          The bidder&rsquo;s email address and first name are read from Shopify only at the moment we send an auction email
          (an &ldquo;outbid&rdquo; notice or a &ldquo;1 hour left&rdquo; reminder). We do not store email addresses in our database.
        </li>
        <li>A record that a notice was sent (customer ID, auction, notice type and time), so nobody receives the same notice twice.</li>
        <li>When an auction ends, the winner&rsquo;s Shopify customer ID is used to create a Shopify draft order and invoice in the merchant&rsquo;s store.</li>
      </ul>
      <p>Bidders must be signed in to the merchant&rsquo;s store to bid. Other shoppers only ever see bidders as an anonymous label such as &ldquo;Bidder #1234&rdquo;.</p>

      <h2 style={S.h2}>3. How we use information</h2>
      <ul>
        <li>To run auctions: accept and validate bids, calculate prices, show live bids and countdowns, and end auctions on time.</li>
        <li>To invoice auction winners through Shopify.</li>
        <li>To email bidders about auctions they bid on (outbid notices and ending-soon reminders).</li>
        <li>To enforce plan limits and keep the service secure and working.</li>
      </ul>
      <p>We do not sell personal information, use it for advertising, or build profiles of shoppers. The App&rsquo;s storefront code sets no tracking cookies.</p>

      <h2 style={S.h2}>4. Who we share information with</h2>
      <p>We share information only with service providers needed to run the App:</p>
      <ul>
        <li><strong>Shopify</strong> &mdash; the platform the App runs on, including billing.</li>
        <li><strong>Render</strong> &mdash; hosts the App&rsquo;s servers and database.</li>
        <li><strong>Resend</strong> &mdash; delivers auction emails to bidders.</li>
      </ul>
      <p>We may also disclose information if required by law.</p>

      <h2 style={S.h2}>5. Retention and deletion</h2>
      <ul>
        <li>When a merchant uninstalls the App, their store&rsquo;s access credentials are removed right away.</li>
        <li>When Shopify sends the store data-erasure request (about 48 hours after uninstall), we delete that store&rsquo;s auctions, bids, notice records and plan record.</li>
        <li>When Shopify sends a customer data-erasure request, we delete that customer&rsquo;s bids and notice records and remove them as a recorded winner.</li>
        <li>We respond to customer data requests that Shopify forwards to us.</li>
      </ul>

      <h2 style={S.h2}>6. Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct or delete your personal information. Shoppers should
        contact the store where they bid; merchants and shoppers can also contact us directly using the details below.
      </p>

      <h2 style={S.h2}>7. Security</h2>
      <p>Data is sent over encrypted connections, stored in a private database that blocks outside access, and every storefront request is verified by Shopify&rsquo;s signature before it is processed.</p>

      <h2 style={S.h2}>8. Children</h2>
      <p>The App is not directed at children under 16, and we do not knowingly collect their information.</p>

      <h2 style={S.h2}>9. Changes</h2>
      <p>We may update this policy. The effective date above shows when it last changed.</p>

      <h2 style={S.h2}>10. Contact</h2>
      <p>
        Hellfire Auctions &mdash; <a href="mailto:support@hellfireauctions.com" style={{ color: "#c2410c" }}>support@hellfireauctions.com</a>
      </p>
    </main>
  );
}
