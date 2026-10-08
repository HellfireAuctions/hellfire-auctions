import { useEffect, useState } from "react";
import { redirect, Form, useLoaderData, useNavigate } from "react-router";
import { login } from "../../shopify.server";
import { shouldOpenApp } from "../../root-redirect";
import styles from "./styles.module.css";

// The app's public home page. Shopify's admin never sees it: anything that looks like it comes from the admin is sent
// straight on to the app (see root-redirect.js).
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (shouldOpenApp(request.url, request.headers.get("sec-fetch-dest"))) {
    throw redirect(`/app${url.search}`);
  }
  return { showForm: Boolean(login) };
};

export const meta = () => [
  { title: "Hellfire Auctions: live auctions for Shopify stores" },
  { name: "description", content: "Turn any product into a live auction on your Shopify store, with automatic bidding, instant updates and winner invoices through Shopify." },
];

const FEATURES = [
  ["Automatic bidding", "Shoppers set a maximum and the app bids for them, one increment at a time, only as much as it takes to stay in front."],
  ["Buy It Now, reserves and anti-sniping", "Optional on every auction. Anti-sniping extends an auction when a bid lands in the last moments (Inferno plan)."],
  ["Instant updates", "New bids appear within a second, with no refreshing. A Live Auctions button on every page shows what is running."],
  ["Fits your theme", "Works with Online Store 2.0 themes. Photos are cropped to a square so product grids line up. Available in English, Spanish, French, German, Portuguese, Italian and Dutch."],
  ["Winners are invoiced through Shopify", "When an auction ends, the winner gets a Shopify invoice automatically, and several wins can be combined into one."],
  ["Know how you are doing", "See sales, the share of auctions that sold, how far above the starting bid items sell, and (on Inferno) the best times to end auctions."],
];

export default function App() {
  const { showForm } = useLoaderData();
  const navigate = useNavigate();
  const [inAdmin, setInAdmin] = useState(false);

  // Clicking the app's own name inside the Shopify admin navigates here without asking the server, so the server-side
  // redirect never runs. If this page finds itself inside the admin's frame, it hands straight over to the app.
  useEffect(() => {
    if (window.self !== window.top) {
      setInAdmin(true);
      navigate(`/app${window.location.search}`, { replace: true });
    }
  }, [navigate]);
  if (inAdmin) return null;

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <p className={styles.brand}>Hellfire Auctions</p>
        <h1 className={styles.heading}>Run live auctions on your Shopify store</h1>
        <p className={styles.lead}>
          Turn any product into a live auction with a countdown, automatic bidding and instant updates. When it ends, the winner is invoiced through Shopify. Free to start; paid plans begin at $10 a month with a 7-day free trial.
        </p>

        <ul className={styles.list}>
          {FEATURES.map(([title, text]) => (
            <li key={title}>
              <strong>{title}</strong>
              {text}
            </li>
          ))}
        </ul>

        <section className={styles.card} aria-labelledby="open-title">
          <h2 id="open-title" className={styles.cardTitle}>Already a merchant?</h2>
          <p className={styles.hint}>
            Open Hellfire Auctions from the <strong>Apps</strong> menu in your Shopify admin.
            {showForm ? " You can also enter your store address here." : ""}
          </p>
          {showForm && (
            <Form className={styles.form} method="post" action="/auth/login">
              <label htmlFor="shop" className={styles.hint}>Your store address</label>
              <div className={styles.row}>
                <input id="shop" className={styles.input} type="text" name="shop" placeholder="your-store.myshopify.com" autoComplete="off" />
                <button className={styles.button} type="submit">Open the app</button>
              </div>
            </Form>
          )}
        </section>

        <ul className={styles.links}>
          <li><a href="/pricing">Pricing</a></li>
          <li><a href="/help">Help Center</a></li>
          <li><a href="/privacy">Privacy</a></li>
          <li><a href="/terms">Terms</a></li>
          <li><a href="mailto:support@hellfireauctions.com">support@hellfireauctions.com</a></li>
        </ul>
      </div>
    </main>
  );
}
