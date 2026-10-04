import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { getPrefs, readPrefsToken, savePrefs } from "../prefs.server";

export const meta = () => [
  { title: "Email preferences | Hellfire Auctions" },
  { name: "robots", content: "noindex" },
];

const S = {
  page: { maxWidth: 560, margin: "0 auto", padding: "40px 22px 70px", fontFamily: "Arial, Helvetica, sans-serif", color: "#1c1c1c", lineHeight: 1.55 },
  card: { border: "1px solid #e3e3e3", borderRadius: 16, padding: "22px 20px", background: "#fff" },
  row: { display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 0", borderBottom: "1px solid #eee" },
  master: { display: "flex", gap: 12, alignItems: "flex-start", padding: "14px", background: "#fff8e1", border: "1px solid #ffd60a", borderRadius: 12, marginBottom: 16 },
  btn: { background: "#ff3b30", color: "#fff", fontWeight: 800, padding: "12px 22px", borderRadius: 8, border: 0, cursor: "pointer", fontSize: 15 },
};

export const loader = async ({ request }) => {
  const token = new URL(request.url).searchParams.get("t");
  const who = readPrefsToken(token);
  if (!who) return { valid: false };
  return { valid: true, shop: who.shop, token, prefs: await getPrefs(who.shop, who.customerId) };
};

export const action = async ({ request }) => {
  const token = new URL(request.url).searchParams.get("t");
  const who = readPrefsToken(token);
  if (!who) return Response.json({ error: "This link isn't valid." }, { status: 400 });
  const form = await request.formData();
  // One-click unsubscribe, sent by mail providers as "List-Unsubscribe=One-Click": keep only the necessary emails.
  if (form.get("List-Unsubscribe")) {
    await savePrefs(who.shop, who.customerId, { outbid: false, reminders: false, results: false, essentialOnly: true });
    return new Response("Unsubscribed", { status: 200 });
  }
  const essentialOnly = form.get("essentialOnly") === "on";
  const current = await getPrefs(who.shop, who.customerId);
  const prefs = await savePrefs(
    who.shop,
    who.customerId,
    essentialOnly
      ? { ...current, essentialOnly: true } // keep their individual choices for later
      : {
          outbid: form.get("outbid") === "on",
          reminders: form.get("reminders") === "on",
          results: form.get("results") === "on",
          essentialOnly: false,
        },
  );
  return { saved: true, prefs };
};

export default function EmailPreferences() {
  const data = useLoaderData();
  const result = useActionData();
  const prefs = data.valid ? result?.prefs || data.prefs : null;
  const [essential, setEssential] = useState(Boolean(prefs?.essentialOnly));

  if (!data.valid) {
    return (
      <main style={S.page}>
        <h1>Email preferences</h1>
        <p>This link isn't valid anymore. Please use the "Manage the emails you get" link from one of our emails, or from your My Auctions page.</p>
      </main>
    );
  }
  const dim = { opacity: essential ? 0.5 : 1 };
  return (
    <main style={S.page}>
      <h1 style={{ margin: "0 0 6px" }}>Email preferences</h1>
      <p style={{ margin: "0 0 18px", color: "#616161" }}>For auctions at {data.shop}. Choose which emails you'd like to get.</p>
      {result?.saved && (
        <div style={{ background: "#e8f5e9", border: "1px solid #b7dfc9", color: "#1b5e20", borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
          Saved. Your choices are updated.
        </div>
      )}
      <Form method="post" action={`/email-preferences?t=${data.token}`} style={S.card}>
        <label style={S.master}>
          <input
            type="checkbox"
            name="essentialOnly"
            checked={essential}
            onChange={(e) => setEssential(e.target.checked)}
            style={{ marginTop: 3, width: 20, height: 20 }}
          />
          <span>
            <strong>Receive only necessary emails</strong>
            <br />
            <span style={{ color: "#616161", fontSize: 14 }}>
              Necessary emails are the "1 hour left" reminder before an auction ends, and emails about auctions you win: your winner notice, your invoice and payment reminders. Turning this on switches off everything else, including outbid alerts, "starting" alerts for auctions you're watching, and results emails.
            </span>
          </span>
        </label>

        <div style={dim}>
          <div style={{ fontWeight: 700, margin: "4px 0" }}>Or choose exactly what you'd like</div>
          <label style={S.row}>
            <input type="checkbox" name="outbid" defaultChecked={prefs.outbid} disabled={essential} style={{ marginTop: 4 }} />
            <span><strong>Outbid alerts</strong><br />Tell me right away when someone outbids me.</span>
          </label>
          <label style={S.row}>
            <input type="checkbox" name="reminders" defaultChecked={prefs.reminders} disabled={essential} style={{ marginTop: 4 }} />
            <span><strong>Reminders</strong><br />"1 hour left" on auctions I bid on, and "starting" or "ending soon" on auctions I'm watching.</span>
          </label>
          <label style={{ ...S.row, borderBottom: 0 }}>
            <input type="checkbox" name="results" defaultChecked={prefs.results} disabled={essential} style={{ marginTop: 4 }} />
            <span><strong>Results</strong><br />When an auction ends and I didn't win, or the reserve wasn't met.</span>
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          <button type="submit" name="intent" value="save" style={S.btn}>Save my choices</button>
        </div>
      </Form>
      <p style={{ color: "#616161", fontSize: 14, marginTop: 16 }}>
        Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.
      </p>
    </main>
  );
}
