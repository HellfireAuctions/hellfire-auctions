// Public Security & Incident Response Policy for Hellfire Auctions.
export const meta = () => [{ title: "Security Policy | Hellfire Auctions" }];

const S = {
  page: { maxWidth: 820, margin: "0 auto", padding: "40px 22px 60px", fontFamily: "Arial, Helvetica, sans-serif", color: "#1c1c1c", lineHeight: 1.6 },
  hero: { background: "linear-gradient(90deg,#1a0000,#7a0000,#ff3b30)", color: "#fff", borderRadius: 16, padding: "28px 26px", marginBottom: 28 },
  h2: { fontSize: 20, marginTop: 30, marginBottom: 8, color: "#7a0000" },
};

export default function Security() {
  return (
    <main style={S.page}>
      <div style={S.hero}>
        <div style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffd60a", fontWeight: 700 }}>Hellfire Auctions</div>
        <h1 style={{ margin: "6px 0 4px", fontSize: 32 }}>Security &amp; Incident Response Policy</h1>
        <div>Effective October 2, 2026</div>
      </div>

      <h2 style={S.h2}>1. How data is protected</h2>
      <ul>
        <li><strong>Encryption:</strong> all traffic uses HTTPS/TLS; the database encrypts data at rest and requires encrypted connections.</li>
        <li><strong>Minimal data:</strong> we store customer IDs and bid details only. Email addresses are read from Shopify at send time and are not stored.</li>
        <li><strong>Verified requests:</strong> every storefront and webhook request is checked against Shopify&rsquo;s signature before it is processed.</li>
        <li><strong>Access control:</strong> only the app owner can access production systems. Accounts use strong unique passwords and two-step verification. The database blocks outside connections.</li>
        <li><strong>Logging:</strong> the server logs bids and data requests with timestamps and customer IDs (no email addresses or payment data).</li>
        <li><strong>Test vs production:</strong> development and testing use development stores and a separate test database branch; production merchant data is never copied into testing.</li>
        <li><strong>Data loss prevention:</strong> the database keeps a point-in-time restore history, merchants can download a full backup from the App at any time, and failures that affect auctions trigger automatic alerts to the owner.</li>
      </ul>

      <h2 style={S.h2}>2. Incident response</h2>
      <p>A security incident is any event that may have exposed, altered or destroyed personal data, or allowed unauthorised access to our systems. When one is suspected we will:</p>
      <ol>
        <li><strong>Contain</strong> &mdash; immediately revoke or rotate affected credentials and API keys, block the access path, and take affected services offline if needed.</li>
        <li><strong>Assess</strong> &mdash; use server logs and database history to determine what happened, which stores and customers are affected, and what data was involved.</li>
        <li><strong>Notify</strong> &mdash; inform affected merchants and Shopify without undue delay and within 72 hours of becoming aware, including what happened, what data was involved, and the steps taken; we support merchants in notifying their customers and authorities where required.</li>
        <li><strong>Recover</strong> &mdash; restore correct data from point-in-time history where needed and confirm services are working.</li>
        <li><strong>Learn</strong> &mdash; record the incident, fix the root cause, and update these safeguards.</li>
      </ol>

      <h2 style={S.h2}>3. Reporting a security issue</h2>
      <p>Email <a href="mailto:support@hellfireauctions.com" style={{ color: "#c2410c" }}>support@hellfireauctions.com</a> with the subject &ldquo;Security&rdquo;. We respond within 2 business days.</p>
    </main>
  );
}
