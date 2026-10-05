// Public help center for Hellfire Auctions (no login required).
export const meta = () => [
  { title: "Help center | Hellfire Auctions" },
  { name: "description", content: "Setup guide, answers to common questions and troubleshooting for Hellfire Auctions, the auction app for Shopify." },
];

const S = {
  page: { maxWidth: 900, margin: "0 auto", padding: "40px 22px 70px", fontFamily: "Arial, Helvetica, sans-serif", color: "#1c1c1c", lineHeight: 1.6 },
  hero: { background: "linear-gradient(90deg,#1a0000,#7a0000,#ff3b30)", color: "#fff", borderRadius: 16, padding: "28px 26px", marginBottom: 28 },
  h2: { fontSize: 22, marginTop: 36, marginBottom: 10, color: "#7a0000" },
  item: { border: "1px solid #e3e3e3", borderRadius: 12, padding: "12px 16px", margin: "0 0 10px", background: "#fff" },
  summary: { cursor: "pointer", fontWeight: 700 },
  a: { color: "#c2410c" },
};

const START = [
  ["Turn the app on in your theme", "In Shopify, open Online Store, then Themes, then Customize. Open App embeds (the plug icon on the left), switch Hellfire Auctions Runtime on and click Save. This adds the bidding panel to auction pages and the live bid badges to product cards. It works with any theme and changes none of your theme's code."],
  ["Make sure shoppers can sign in", "Bidding needs a customer account. In Settings, then Customer accounts, make sure sign-in is on and your store shows an account or sign-in link."],
  ["Make sure your store can take payments", "Winners pay through Shopify's own checkout, so a payment method must be active in Settings, then Payments."],
  ["Create your first auction", "Open Hellfire Auctions and fill in the form: title, description, photos, starting bid, optional reserve price, start time and length. Use a Test auction (5 or 10 minutes) to try everything without a real sale."],
  ["Add \u201CMy Auctions\u201D to your menu", "Use the one-click banner in the app so shoppers can see every auction they are bidding on, have won, lost or paid for."],
  ["Optional: show live auctions on your home page", "In the theme editor, add the Live Auctions section from the Apps tab. It lists only running auctions, soonest-ending first."],
];

const FAQ = [
  ["Bidding", [
    ["How does proxy bidding work?", "A bidder enters the most they are willing to pay. The app bids only as much as needed to stay in front, up to that maximum, the same way eBay does. Maximum bids are never shown to other shoppers or to you."],
    ["Can I limit who bids?", "Yes. Under Who can bid in the app, choose anyone who is signed in (the default), only customers with a verified email address, only customers who have bought from you before, or only customers you have approved by adding a tag to them in Shopify. A shopper who isn\u2019t eligible sees a clear message when they try to bid and can contact you to be approved."],
    ["What are the bid steps?", "Bid increments grow with the price, in tiers like eBay's, so a bid on a $200 item moves in bigger steps than one on a $20 item. Bidders see the minimum next bid before they place one, and a confirm step catches typing mistakes such as an extra zero."],
    ["What does the reserve price do?", "A reserve is the lowest price you will sell for. Shoppers see whether the reserve has been met but never the amount. If the auction ends below it, there is no sale and no one is charged."],
    ["What is anti-sniping?", "On the Inferno plan you can switch on anti-sniping for an auction: a bid in the last 2 minutes adds 2 minutes, so nobody wins by bidding at the last second. It is off unless you turn it on."],
  ]],
  ["Winners and payment", [
    ["How does the winner pay?", "When an auction ends, the winner gets an email with a secure Shopify checkout link and 4 days to pay. They choose from your store's real shipping options at checkout. If a buyer wins several items, their wins are combined on one invoice so they pay shipping once."],
    ["What if the winner doesn't pay?", "Blaze and Inferno send reminders at 1 and 3 days. After 4 days the app offers the item to the next bidder automatically, counts the unpaid sale against the first winner, and, only if you choose a limit under Unpaid winners, blocks bidders who reach it. Nobody is blocked automatically unless you turn that on. You can change or switch off all of this under Unpaid winners in the app."],
    ["Why does the winner's shipping show $0?", "Weight-based shipping rates need a weight. Add a Shipping weight to the auction (on the create form or on the auction's card), or set a Default shipping weight in the app. Then check your rates in Settings, then Shipping and delivery."],
    ["Why does my Shopify product list show a price of $99,999?", "Auction items are saved with a placeholder price so nobody can buy them outside the auction. Shoppers never see it, and the winner always pays exactly their winning bid."],
  ]],
  ["Managing auctions", [
    ["Can I change an auction after it starts?", "As on other auction sites, the starting price, schedule and title are locked once an auction starts. You can add to the description (it is added below the original with the date) and add photos."],
    ["What happens to ended auctions on my store?", "Ended auctions disappear from your product lists about a minute after they end, and anyone who did not bid is sent to your live auctions if they open the old page. Bidders can still open it to see how it went. Items that did not sell are taken off your store about 10 minutes after they end, and Relist puts them back."],
    ["Can I run a whole drop at once?", "Yes. Create your auctions, tick Add to an auction event on the upcoming ones, and schedule them to start together and end one after another. You can also upload a spreadsheet (CSV) to create many auctions at once, repeat them weekly, and relist unsold items automatically."],
    ["Can I remove a bid or block a bidder?", "Yes. Each auction card lists its bidders. You can remove a bid, which recalculates the price, or block a bidder from your store's auctions. Blocked bidders appear in a list where you can unblock them."],
    ["How do I clear paid auctions from my list?", "Use Remove from list on a paid card, or Clear all paid above your auctions. Nothing is deleted: your records, insights and the buyer's history stay, and Show removed brings them back."],
  ]],
  ["Themes, currencies and tax", [
    ["Which themes does it work with?", "The bidding panel and the live bid badges on your product cards are designed to work with any Shopify theme, newer or older. The optional Live Auctions section for your home page needs a newer \u201COnline Store 2.0\u201D theme (nearly every theme released since 2021). On an older theme, link to your Live Auctions collection instead."],
    ["What if my customers shop in another currency?", "Bids are always placed in your store's currency. A shopper browsing in another currency sees an approximate amount next to each price. Shopify decides the currency on the winner's invoice from your Markets settings, so if you sell internationally, run one test order from another country before your first international sale."],
    ["Do bids include tax and shipping?", "A bid is the price of the item. Shopify adds tax and shipping at checkout according to your store's tax and shipping settings. If your store shows tax-inclusive prices, test one invoice first to confirm it displays the way you expect."],
  ]],
  ["Emails, languages and plans", [
    ["Which emails do shoppers get?", "Winners always get their winner notice and invoice. On Blaze and Inferno, bidders also get outbid alerts, a 1-hour-left reminder, watch alerts and result emails. Every shopper can choose which optional emails they receive from a link in each email."],
    ["Does it work in other languages?", "English and Spanish. The bidding panel, product-card badges, My Auctions page and buyer emails appear in Spanish when a shopper browses your store in Spanish (emails follow the buyer's Shopify account language). Add Spanish in Settings, then Languages."],
    ["What counts toward my monthly auction limit?", "Each auction you create, including relisted, repeated and spreadsheet-created auctions. The 5 and 10-minute test auctions never count. Limits reset on the 1st of each month."],
    ["What happens if I uninstall?", "Your open auctions are stopped and the app's access to your store ends right away. Shopify then asks us to erase your store's data about 48 hours later. The products the app created stay in your Shopify product list; you can delete them there."],
  ]],
];

const FIX = [
  ["I don't see the bidding panel on my auction page", "The app embed is probably off. In Online Store, then Themes, then Customize, open App embeds, switch Hellfire Auctions Runtime on and click Save. The app shows a red banner with a direct link when it detects this. If you switched themes, turn it on in the new theme too."],
  ["Shoppers see \u201CLog in to bid\u201D and can't sign in", "Check that customer accounts are on (Settings, then Customer accounts) and that your theme shows a sign-in link."],
  ["An ended auction still shows on my home page", "Ended auctions are hidden about a minute after they end. If one stays, hard-refresh the page (Ctrl + Shift + R) because your browser may be holding an old copy. If it still shows, email us the page address and your theme name."],
  ["Bidders say they don't get emails", "Outbid and reminder emails are part of Blaze and Inferno. Ask them to check spam, and to check the email choices on the link at the bottom of any auction email."],
  ["My auction didn't start or end on time", "Start and end times are in your store's time zone (Settings, then General). Auctions start and end automatically, usually within seconds. If something looks wrong, email us with the auction title and your store address."],
  ["The product is out of stock or the checkout says it's unavailable", "Auction items are held at zero stock on purpose so they can't be bought outside the auction. The winner's invoice link is built to work even though the item is held at zero stock. If a winner reports a problem, use Send reminder, or Offer to next bidder, from the auction card."],
];

export default function Help() {
  return (
    <main style={S.page}>
      <div style={S.hero}>
        <div style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffd60a", fontWeight: 700 }}>Hellfire Auctions</div>
        <h1 style={{ margin: "6px 0 6px", fontSize: 34 }}>Help center</h1>
        <div>Setup, answers and troubleshooting for running auctions in your Shopify store.</div>
      </div>

      <h2 style={S.h2}>Get started in about 10 minutes</h2>
      <ol style={{ paddingLeft: 22 }}>
        {START.map(([title, text]) => (
          <li key={title} style={{ margin: "0 0 12px" }}>
            <strong>{title}.</strong> {text}
          </li>
        ))}
      </ol>

      {FAQ.map(([group, items]) => (
        <section key={group} aria-label={group}>
          <h2 style={S.h2}>{group}</h2>
          {items.map(([q, a]) => (
            <details key={q} style={S.item}>
              <summary style={S.summary}>{q}</summary>
              <p style={{ margin: "10px 0 2px" }}>{a}</p>
            </details>
          ))}
        </section>
      ))}

      <section aria-label="Troubleshooting">
        <h2 style={S.h2}>Troubleshooting</h2>
        {FIX.map(([q, a]) => (
          <details key={q} style={S.item}>
            <summary style={S.summary}>{q}</summary>
            <p style={{ margin: "10px 0 2px" }}>{a}</p>
          </details>
        ))}
      </section>

      <h2 style={S.h2}>Still stuck?</h2>
      <p>
        Email <a href="mailto:support@hellfireauctions.com" style={S.a}>support@hellfireauctions.com</a>. To help us answer fast, include your store address (the one ending in .myshopify.com), the auction title, and what you expected to happen.
      </p>
      <p>
        <a href="/pricing" style={S.a}>Pricing</a>{" \u00B7 "}
        <a href="/privacy" style={S.a}>Privacy Policy</a>{" \u00B7 "}
        <a href="/terms" style={S.a}>Terms of Service</a>{" \u00B7 "}
        <a href="/security" style={S.a}>Security Policy</a>
      </p>
    </main>
  );
}
