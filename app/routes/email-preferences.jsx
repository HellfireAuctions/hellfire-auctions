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

/*I18N:prefs*/const DICT = {
  "es": {
    "Email preferences": "Preferencias de email",
    "This link isn't valid anymore. Please use the \"Manage the emails you get\" link from one of our emails, or from your My Auctions page.": "Este enlace ya no es válido. Usa el enlace \"Administra los emails que recibes\" de uno de nuestros emails, o desde tu página Mis subastas.",
    "For auctions at {shop}. Choose which emails you'd like to get.": "Para las subastas de {shop}. Elige qué emails quieres recibir.",
    "Saved. Your choices are updated.": "Guardado. Tus preferencias están actualizadas.",
    "Receive only necessary emails": "Recibir solo los emails necesarios",
    "Necessary emails are the \"1 hour left\" reminder before an auction ends, and emails about auctions you win: your winner notice, your invoice and payment reminders. Turning this on switches off everything else, including outbid alerts, \"starting\" alerts for auctions you're watching, and results emails.": "Los emails necesarios son el recordatorio de \"queda 1 hora\" antes de que termine una subasta y los emails sobre las subastas que ganas: tu aviso de ganador, tu factura y los recordatorios de pago. Al activarlo se desactiva todo lo demás, incluidos los avisos de que te superan, los avisos de inicio de las subastas que sigues y los emails de resultados.",
    "Or choose exactly what you'd like": "O elige exactamente lo que quieres",
    "Outbid alerts": "Avisos de puja superada",
    "Tell me right away when someone outbids me.": "Avísame al instante cuando alguien me supere.",
    "Reminders": "Recordatorios",
    "\"1 hour left\" on auctions I bid on, and \"starting\" or \"ending soon\" on auctions I'm watching.": "\"Queda 1 hora\" en las subastas en las que puje, y \"empieza\" o \"termina pronto\" en las que sigo.",
    "Results": "Resultados",
    "When an auction ends and I didn't win, or the reserve wasn't met.": "Cuando una subasta termina y no gané, o no se alcanzó la reserva.",
    "Save my choices": "Guardar mis preferencias",
    "Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.": "Los emails sobre una subasta que ganaste, tu factura y los recordatorios de pago siempre llegan, porque tratan de una compra a la que te has comprometido."
  },
  "fr": {
    "Email preferences": "Préférences d’e-mail",
    "This link isn't valid anymore. Please use the \"Manage the emails you get\" link from one of our emails, or from your My Auctions page.": "Ce lien n’est plus valide. Utilisez le lien « Gérer les e-mails que vous recevez » dans l’un de nos e-mails, ou depuis votre page Mes enchères.",
    "For auctions at {shop}. Choose which emails you'd like to get.": "Pour les enchères de {shop}. Choisissez les e-mails que vous souhaitez recevoir.",
    "Saved. Your choices are updated.": "Enregistré. Vos choix sont à jour.",
    "Receive only necessary emails": "Recevoir uniquement les e-mails nécessaires",
    "Necessary emails are the \"1 hour left\" reminder before an auction ends, and emails about auctions you win: your winner notice, your invoice and payment reminders. Turning this on switches off everything else, including outbid alerts, \"starting\" alerts for auctions you're watching, and results emails.": "Les e-mails nécessaires sont le rappel « plus qu’1 heure » avant la fin d’une enchère et les e-mails concernant les enchères que vous remportez : votre avis de victoire, votre facture et les rappels de paiement. L’activer désactive tout le reste, y compris les alertes de surenchère, les alertes de début pour les enchères que vous suivez et les e-mails de résultats.",
    "Or choose exactly what you'd like": "Ou choisissez exactement ce que vous voulez",
    "Outbid alerts": "Alertes de surenchère",
    "Tell me right away when someone outbids me.": "Prévenez-moi tout de suite quand quelqu’un surenchérit.",
    "Reminders": "Rappels",
    "\"1 hour left\" on auctions I bid on, and \"starting\" or \"ending soon\" on auctions I'm watching.": "« Plus qu’1 heure » pour les enchères auxquelles je participe, et « commence » ou « se termine bientôt » pour celles que je suis.",
    "Results": "Résultats",
    "When an auction ends and I didn't win, or the reserve wasn't met.": "Quand une enchère se termine sans que je gagne, ou que le prix de réserve n’est pas atteint.",
    "Save my choices": "Enregistrer mes choix",
    "Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.": "Les e-mails concernant une enchère que vous avez remportée, votre facture et les rappels de paiement vous parviennent toujours, car ils concernent un achat auquel vous vous êtes engagé."
  },
  "de": {
    "Email preferences": "E-Mail-Einstellungen",
    "This link isn't valid anymore. Please use the \"Manage the emails you get\" link from one of our emails, or from your My Auctions page.": "Dieser Link ist nicht mehr gültig. Bitte verwenden Sie den Link „E-Mails verwalten, die Sie erhalten“ in einer unserer E-Mails oder auf Ihrer Seite „Meine Auktionen“.",
    "For auctions at {shop}. Choose which emails you'd like to get.": "Für Auktionen bei {shop}. Wählen Sie, welche E-Mails Sie erhalten möchten.",
    "Saved. Your choices are updated.": "Gespeichert. Ihre Auswahl ist aktualisiert.",
    "Receive only necessary emails": "Nur notwendige E-Mails erhalten",
    "Necessary emails are the \"1 hour left\" reminder before an auction ends, and emails about auctions you win: your winner notice, your invoice and payment reminders. Turning this on switches off everything else, including outbid alerts, \"starting\" alerts for auctions you're watching, and results emails.": "Notwendige E-Mails sind die Erinnerung „Noch 1 Stunde“ vor dem Ende einer Auktion sowie E-Mails zu Auktionen, die Sie gewinnen: Ihre Gewinnbenachrichtigung, Ihre Rechnung und Zahlungserinnerungen. Wenn Sie dies aktivieren, wird alles andere ausgeschaltet, auch Benachrichtigungen bei Überbietung, Start-Benachrichtigungen für beobachtete Auktionen und Ergebnis-E-Mails.",
    "Or choose exactly what you'd like": "Oder wählen Sie genau, was Sie möchten",
    "Outbid alerts": "Benachrichtigungen bei Überbietung",
    "Tell me right away when someone outbids me.": "Benachrichtigen Sie mich sofort, wenn mich jemand überbietet.",
    "Reminders": "Erinnerungen",
    "\"1 hour left\" on auctions I bid on, and \"starting\" or \"ending soon\" on auctions I'm watching.": "„Noch 1 Stunde“ bei Auktionen, auf die ich biete, und „startet“ oder „endet bald“ bei Auktionen, die ich beobachte.",
    "Results": "Ergebnisse",
    "When an auction ends and I didn't win, or the reserve wasn't met.": "Wenn eine Auktion endet und ich nicht gewonnen habe oder der Mindestpreis nicht erreicht wurde.",
    "Save my choices": "Meine Auswahl speichern",
    "Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.": "E-Mails zu einer gewonnenen Auktion, Ihre Rechnung und Zahlungserinnerungen erhalten Sie immer, weil es um einen Kauf geht, zu dem Sie sich verpflichtet haben."
  },
  "pt": {
    "Email preferences": "Preferências de e-mail",
    "This link isn't valid anymore. Please use the \"Manage the emails you get\" link from one of our emails, or from your My Auctions page.": "Este link não é mais válido. Use o link “Gerenciar os e-mails que você recebe” em um dos nossos e-mails, ou na sua página Meus leilões.",
    "For auctions at {shop}. Choose which emails you'd like to get.": "Para os leilões de {shop}. Escolha quais e-mails você quer receber.",
    "Saved. Your choices are updated.": "Salvo. Suas escolhas foram atualizadas.",
    "Receive only necessary emails": "Receber apenas os e-mails necessários",
    "Necessary emails are the \"1 hour left\" reminder before an auction ends, and emails about auctions you win: your winner notice, your invoice and payment reminders. Turning this on switches off everything else, including outbid alerts, \"starting\" alerts for auctions you're watching, and results emails.": "Os e-mails necessários são o lembrete “falta 1 hora” antes do fim de um leilão e os e-mails sobre os leilões que você ganha: seu aviso de vitória, sua fatura e os lembretes de pagamento. Ao ativar, todo o resto é desligado, incluindo alertas de lance superado, alertas de início dos leilões que você acompanha e e-mails de resultados.",
    "Or choose exactly what you'd like": "Ou escolha exatamente o que você quer",
    "Outbid alerts": "Alertas de lance superado",
    "Tell me right away when someone outbids me.": "Avise-me na hora quando alguém superar meu lance.",
    "Reminders": "Lembretes",
    "\"1 hour left\" on auctions I bid on, and \"starting\" or \"ending soon\" on auctions I'm watching.": "“Falta 1 hora” nos leilões em que dou lances, e “começando” ou “terminando em breve” nos que acompanho.",
    "Results": "Resultados",
    "When an auction ends and I didn't win, or the reserve wasn't met.": "Quando um leilão termina e eu não ganhei, ou o preço de reserva não foi atingido.",
    "Save my choices": "Salvar minhas escolhas",
    "Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.": "Os e-mails sobre um leilão que você ganhou, sua fatura e os lembretes de pagamento sempre chegam, porque tratam de uma compra com a qual você se comprometeu."
  },
  "it": {
    "Email preferences": "Preferenze email",
    "This link isn't valid anymore. Please use the \"Manage the emails you get\" link from one of our emails, or from your My Auctions page.": "Questo link non è più valido. Usa il link «Gestisci le email che ricevi» in una delle nostre email, oppure dalla tua pagina Le mie aste.",
    "For auctions at {shop}. Choose which emails you'd like to get.": "Per le aste di {shop}. Scegli quali email vuoi ricevere.",
    "Saved. Your choices are updated.": "Salvato. Le tue scelte sono aggiornate.",
    "Receive only necessary emails": "Ricevi solo le email necessarie",
    "Necessary emails are the \"1 hour left\" reminder before an auction ends, and emails about auctions you win: your winner notice, your invoice and payment reminders. Turning this on switches off everything else, including outbid alerts, \"starting\" alerts for auctions you're watching, and results emails.": "Le email necessarie sono il promemoria «manca 1 ora» prima della fine di un'asta e le email sulle aste che vinci: l'avviso di vincita, la fattura e i solleciti di pagamento. Attivandolo si disattiva tutto il resto, compresi gli avvisi di offerta superata, gli avvisi di inizio per le aste che segui e le email dei risultati.",
    "Or choose exactly what you'd like": "Oppure scegli esattamente cosa vuoi",
    "Outbid alerts": "Avvisi di offerta superata",
    "Tell me right away when someone outbids me.": "Avvisami subito quando qualcuno supera la mia offerta.",
    "Reminders": "Promemoria",
    "\"1 hour left\" on auctions I bid on, and \"starting\" or \"ending soon\" on auctions I'm watching.": "«Manca 1 ora» per le aste in cui ho fatto offerte, e «inizia» o «termina presto» per le aste che sto seguendo.",
    "Results": "Risultati",
    "When an auction ends and I didn't win, or the reserve wasn't met.": "Quando un'asta termina e non ho vinto, o il prezzo di riserva non è stato raggiunto.",
    "Save my choices": "Salva le mie scelte",
    "Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.": "Le email su un'asta che hai vinto, la fattura e i solleciti di pagamento arrivano sempre, perché riguardano un acquisto a cui ti sei impegnato."
  },
  "nl": {
    "Email preferences": "E-mailvoorkeuren",
    "This link isn't valid anymore. Please use the \"Manage the emails you get\" link from one of our emails, or from your My Auctions page.": "Deze link is niet meer geldig. Gebruik de link “E-mails beheren die je ontvangt” in een van onze e-mails, of op je pagina Mijn veilingen.",
    "For auctions at {shop}. Choose which emails you'd like to get.": "Voor veilingen bij {shop}. Kies welke e-mails je wilt ontvangen.",
    "Saved. Your choices are updated.": "Opgeslagen. Je keuzes zijn bijgewerkt.",
    "Receive only necessary emails": "Alleen noodzakelijke e-mails ontvangen",
    "Necessary emails are the \"1 hour left\" reminder before an auction ends, and emails about auctions you win: your winner notice, your invoice and payment reminders. Turning this on switches off everything else, including outbid alerts, \"starting\" alerts for auctions you're watching, and results emails.": "Noodzakelijke e-mails zijn de herinnering “nog 1 uur” voordat een veiling afloopt en e-mails over veilingen die je wint: je winnaarsbericht, je factuur en betalingsherinneringen. Als je dit inschakelt, gaat al het andere uit, ook meldingen bij overbieden, startmeldingen voor veilingen die je volgt en resultaat-e-mails.",
    "Or choose exactly what you'd like": "Of kies precies wat je wilt",
    "Outbid alerts": "Meldingen bij overbieden",
    "Tell me right away when someone outbids me.": "Laat het me meteen weten als iemand me overbiedt.",
    "Reminders": "Herinneringen",
    "\"1 hour left\" on auctions I bid on, and \"starting\" or \"ending soon\" on auctions I'm watching.": "“Nog 1 uur” bij veilingen waarop ik bied, en “begint” of “eindigt binnenkort” bij veilingen die ik volg.",
    "Results": "Resultaten",
    "When an auction ends and I didn't win, or the reserve wasn't met.": "Wanneer een veiling afloopt en ik niet heb gewonnen, of de reserveprijs niet is bereikt.",
    "Save my choices": "Mijn keuzes opslaan",
    "Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.": "E-mails over een gewonnen veiling, je factuur en betalingsherinneringen ontvang je altijd, omdat ze gaan over een aankoop waartoe je je hebt verplicht."
  }
};/*END*/

// The email link says which language it was sent in (&l=es); otherwise follow the browser's language.
function pickLang(request) {
  const known = ["en", ...Object.keys(DICT)];
  const asked = (new URL(request.url).searchParams.get("l") || "").slice(0, 2).toLowerCase();
  if (known.includes(asked)) return asked;
  const first = (request.headers.get("accept-language") || "").toLowerCase().slice(0, 2);
  return known.includes(first) ? first : "en";
}

export const loader = async ({ request }) => {
  const token = new URL(request.url).searchParams.get("t");
  const lang = pickLang(request);
  const who = readPrefsToken(token);
  if (!who) return { valid: false, lang };
  return { valid: true, lang, shop: who.shop, token, prefs: await getPrefs(who.shop, who.customerId) };
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
  const t = (en, vars) => {
    const D = DICT[data.lang];
    let s = D && D[en] ? D[en] : en;
    if (vars) for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  };

  if (!data.valid) {
    return (
      <main style={S.page}>
        <h1>{t("Email preferences")}</h1>
        <p>{t("This link isn't valid anymore. Please use the \"Manage the emails you get\" link from one of our emails, or from your My Auctions page.")}</p>
      </main>
    );
  }
  const dim = { opacity: essential ? 0.5 : 1 };
  return (
    <main style={S.page}>
      <h1 style={{ margin: "0 0 6px" }}>{t("Email preferences")}</h1>
      <p style={{ margin: "0 0 18px", color: "#616161" }}>{t("For auctions at {shop}. Choose which emails you'd like to get.", { shop: data.shop })}</p>
      {result?.saved && (
        <div style={{ background: "#e8f5e9", border: "1px solid #b7dfc9", color: "#1b5e20", borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
          {t("Saved. Your choices are updated.")}
        </div>
      )}
      <Form method="post" action={`/email-preferences?t=${data.token}${data.lang !== "en" ? "&l=" + data.lang : ""}`} style={S.card}>
        <label style={S.master}>
          <input
            type="checkbox"
            name="essentialOnly"
            checked={essential}
            onChange={(e) => setEssential(e.target.checked)}
            style={{ marginTop: 3, width: 20, height: 20 }}
          />
          <span>
            <strong>{t("Receive only necessary emails")}</strong>
            <br />
            <span style={{ color: "#616161", fontSize: 14 }}>
              {t("Necessary emails are the \"1 hour left\" reminder before an auction ends, and emails about auctions you win: your winner notice, your invoice and payment reminders. Turning this on switches off everything else, including outbid alerts, \"starting\" alerts for auctions you're watching, and results emails.")}
            </span>
          </span>
        </label>

        <div style={dim}>
          <div style={{ fontWeight: 700, margin: "4px 0" }}>{t("Or choose exactly what you'd like")}</div>
          <label style={S.row}>
            <input type="checkbox" name="outbid" defaultChecked={prefs.outbid} disabled={essential} style={{ marginTop: 4 }} />
            <span><strong>{t("Outbid alerts")}</strong><br />{t("Tell me right away when someone outbids me.")}</span>
          </label>
          <label style={S.row}>
            <input type="checkbox" name="reminders" defaultChecked={prefs.reminders} disabled={essential} style={{ marginTop: 4 }} />
            <span><strong>{t("Reminders")}</strong><br />{t("\"1 hour left\" on auctions I bid on, and \"starting\" or \"ending soon\" on auctions I'm watching.")}</span>
          </label>
          <label style={{ ...S.row, borderBottom: 0 }}>
            <input type="checkbox" name="results" defaultChecked={prefs.results} disabled={essential} style={{ marginTop: 4 }} />
            <span><strong>{t("Results")}</strong><br />{t("When an auction ends and I didn't win, or the reserve wasn't met.")}</span>
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          <button type="submit" name="intent" value="save" style={S.btn}>{t("Save my choices")}</button>
        </div>
      </Form>
      <p style={{ color: "#616161", fontSize: 14, marginTop: 16 }}>
        {t("Emails about an auction you won, your invoice and payment reminders always arrive, because they're about a purchase you've committed to.")}
      </p>
    </main>
  );
}
