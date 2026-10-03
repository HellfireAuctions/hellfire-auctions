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
  btn: { background: "#ff3b30", color: "#fff", fontWeight: 800, padding: "12px 20px", borderRadius: 8, border: 0, cursor: "pointer", fontSize: 15 },
  btn2: { background: "#fff", color: "#1c1c1c", fontWeight: 700, padding: "12px 20px", borderRadius: 8, border: "2px solid #1c1c1c", cursor: "pointer", fontSize: 15 },
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
  // One-click unsubscribe, sent by mail providers as "List-Unsubscribe=One-Click".
  if (form.get("List-Unsubscribe")) {
    await savePrefs(who.shop, who.customerId, { outbid: false, reminders: false, results: false });
    return new Response("Unsubscribed", { status: 200 });
  }
  const none = form.get("intent") === "none";
  const prefs = await savePrefs(
    who.shop,
    who.customerId,
    none ? { outbid: false, reminders: false, results: false } : {
      outbid: form.get("outbid") === "on",
      reminders: form.get("reminders") === "on",
      results: form.get("results") === "on",
    },
  );
  return { saved: true, prefs };
};

export default function EmailPreferences() {
  const data = useLoaderData();
  const result = useActionData();
  if (!data.valid) {
    return (
      <main style={S.page}>
        <h1>Email preferences</h1>
        <p>This link isn't valid anymore. Please use the "Manage the emails you get" link from one of our emails, or from your My Auctions page.</p>
      </main>
    );
  }
  const prefs = result?.prefs || data.prefs;
  return (
    <main style={S.page}>
      <h1 style={{ margin: "0 0 6px" }}>Email preferences</h1>
      <p style={{ margin: "0 0 18px", color: "#616161" }}>For auctions at {data.shop}. Choose which emails you'd like to get.</p>
      {result?.saved && (
        <div style={{ background: "#e8f5e9", border: "1px solid #b7dfc9", color: "#1b5e20", borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
          Saved. Your choices are updated.
        </div>
      )}
      <Form method="post" action={`/email-preferences?t=${data.token}`} key={JSON.stringify(prefs)} style={S.card}>
        <label style={S.row}>
          <input type="checkbox" name="outbid" defaultChecked={prefs.outbid} style={{ marginTop: 4 }} />
          <span><strong>Outbid alerts</strong><br />Tell me right away when someone outbids me.</span>
        </label>
        <label style={S.row}>
          <input type="checkbox" name="reminders" defaultChecked={prefs.reminders} style={{ marginTop: 4 }} />
          <span><strong>Reminders</strong><br />"1 hour left" on auctions I bid on, and "starting" or "ending soon" on auctions I'm watching.</span>
        </label>
        <label style={{ ...S.row, borderBottom: 0 }}>
          <input type="checkbox" name="results" defaultChecked={prefs.results} style={{ marginTop: 4 }} />
          <span><strong>Results</strong><br />When an auction ends and I didn't win, or the reserve wasn't met.</span>
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <button type="submit" name="intent" value="save" style={S.btn}>Save my choices</button>
          <button type="submit" name="intent" value="none" style={S.btn2}>Turn all of these off</button>
        </div>
      </Form>
      <p style={{ color: "#616161", fontSize: 14, marginTop: 16 }}>
        Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.
      </p>
    </main>
  );
}
