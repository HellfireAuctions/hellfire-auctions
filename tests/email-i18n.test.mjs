import assert from "node:assert/strict";
import { DICT, LANGS, translateText, translateEmailParts, localizeTime, normalizeLang, placeholders, footerWords } from "../app/email-i18n.server.js";

const SAMPLE = { title: "Red Coral", money: "$12.50", time: "Oct 4, 2:00 PM EDT", n: "3", shop: "Hellfire Frags", url: "https://shop.test/apps/hellfire-auctions/my-auctions" };
const fill = (text, overrides = {}) => text.replace(/\{(\w+)\}/g, (_, k) => overrides[k] ?? SAMPLE[k]);

assert.deepEqual(LANGS.sort(), ["de", "es", "fr", "it", "nl", "pt"], "the languages the emails support");

// every sentence in every language translates to exactly what the catalog says, with the date written that language's way
let covered = 0;
for (const lang of LANGS) {
  for (const [en, translation] of Object.entries(DICT[lang])) {
    assert.equal(placeholders(en), placeholders(translation), `${lang}: placeholders differ for: ${en}`);
    const expected = fill(translation, { time: localizeTime(lang, SAMPLE.time) });
    assert.equal(translateText(fill(en), lang), expected, `${lang}: wrong translation for: ${en}`);
    covered += 1;
  }
}

// dates are written the way each language writes them
assert.equal(localizeTime("es", "Oct 4, 2:00 PM EDT"), "4 oct, 2:00 p. m. EDT");
assert.equal(localizeTime("fr", "Oct 4, 2:00 PM EDT"), "4 oct., 14:00 EDT");
assert.equal(localizeTime("de", "Oct 4, 2:00 PM EDT"), "4. Okt., 14:00 Uhr EDT");
assert.equal(localizeTime("pt", "Oct 4, 2:00 PM EDT"), "4 de out., 14:00 EDT");
assert.equal(localizeTime("it", "Oct 4, 2:00 PM EDT"), "4 ott, 14:00 EDT");
assert.equal(localizeTime("nl", "Oct 4, 2:00 PM EDT"), "4 okt., 14:00 EDT");
assert.equal(localizeTime("fr", "Dec 25, 12:30 AM PST"), "25 déc., 00:30 PST");
assert.equal(localizeTime("fr", "Mar 3, 12:05 PM UTC"), "3 mars, 12:05 UTC");
assert.equal(localizeTime("de", "Mar 3, 9:07 AM UTC"), "3. März, 09:07 Uhr UTC");
assert.equal(localizeTime("fr", "something else"), "something else");

// the most specific wording wins ("reserve not met" must not be caught by the generic "Auction ended")
for (const lang of LANGS) {
  const specific = translateText("Auction ended: reserve not met — Red Coral", lang);
  const generic = translateText("Auction ended: Red Coral", lang);
  assert.notEqual(specific, generic, `${lang}: specific and generic subjects must differ`);
  assert.ok(specific.includes("Red Coral") && generic.includes("Red Coral"));
}

// a whole outbid email, end to end, in French
const fr = translateEmailParts("fr", {
  subject: "You've been outbid on Red Coral",
  heading: "You've been outbid!",
  lines: ["Hey there,", "We're letting you know you've been outbid on \"Red Coral\". The current bid is now $12.50.", "The auction ends Oct 4, 2:00 PM EDT, so jump back in and raise your bid before time runs out."],
  buttonLabel: "Bid Again Now",
});
assert.equal(fr.subject, "Vous avez été surenchéri sur Red Coral");
assert.equal(fr.lines[0], "Bonjour,");
assert.ok(fr.lines[1].includes("Red Coral") && fr.lines[1].includes("$12.50"));
assert.ok(fr.lines[2].includes("4 oct., 14:00 EDT"));

// the original Spanish behaviour is unchanged
const es = translateEmailParts("es", { subject: "You've been outbid on Red Coral", heading: "You've been outbid!", lines: ["Hey there,"], buttonLabel: "Bid Again Now" });
assert.equal(es.subject, "Te han superado en Red Coral");
assert.equal(es.heading, "¡Te han superado!");
assert.equal(es.lines[0], "Hola,");
assert.equal(es.buttonLabel, "Pujar de nuevo");

// anything unknown, merchant emails, English buyers and unsupported languages stay exactly as they are
for (const lang of [...LANGS, "en", "sv", undefined]) assert.equal(translateText("The winner hasn't paid", lang), "The winner hasn't paid");
const same = { subject: "s", heading: "h", lines: ["Hey there,"], buttonLabel: "Bid now" };
assert.equal(translateEmailParts("en", same), same);
assert.equal(translateEmailParts("sv", same), same);
assert.equal(translateText(undefined, "fr"), undefined);
assert.equal(translateText("You've been outbid on 50% off $$ (rare) [new] {x}", "fr"), "Vous avez été surenchéri sur 50% off $$ (rare) [new] {x}");

// languages from Shopify account settings
for (const [locale, expected] of [["es", "es"], ["es-MX", "es"], ["ES", "es"], ["fr", "fr"], ["fr-CA", "fr"], ["de", "de"], ["de-AT", "de"], ["pt", "pt"], ["pt-BR", "pt"], ["pt-PT", "pt"], ["it", "it"], ["it-IT", "it"], ["nl", "nl"], ["nl-BE", "nl"], ["sv", "en"], ["en", "en"], [undefined, "en"], ["", "en"]]) {
  assert.equal(normalizeLang(locale), expected, String(locale));
}

// footers
for (const lang of [...LANGS, "en"]) {
  const words = footerWords(lang);
  assert.ok(words.sent("Boutique X").includes("Boutique X") && words.sent("Boutique X").includes("Hellfire Auctions"), lang);
  assert.ok(words.manage.length > 10, lang);
}
assert.ok(footerWords("fr").sent("X").startsWith("Envoyé par X"));
assert.ok(footerWords("de").sent("X").startsWith("Gesendet von X"));
assert.ok(footerWords("pt").sent("X").startsWith("Enviado por X"));
assert.ok(footerWords("es").sent("X").startsWith("Enviado por X"));
assert.ok(footerWords("it").sent("X").startsWith("Inviato da X"));
assert.ok(footerWords("nl").sent("X").startsWith("Verzonden door X"));
assert.ok(footerWords("sv").sent("X").startsWith("Sent by X"), "an unsupported language gets English");

console.log(`Email translations: ${covered} sentences across ${LANGS.length} languages all check out`);
