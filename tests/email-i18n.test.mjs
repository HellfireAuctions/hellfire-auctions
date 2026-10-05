import assert from "node:assert/strict";
import { RULES, translateText, translateEmailParts, esTime, normalizeLang, placeholders, footerWords } from "../app/email-i18n.server.js";

const SAMPLE = { title: "Red Coral", money: "$12.50", time: "Oct 4, 2:00 PM EDT", n: "3", shop: "Hellfire Frags", url: "https://shop.test/apps/hellfire-auctions/my-auctions" };
const fill = (text, overrides = {}) => text.replace(/\{(\w+)\}/g, (_, k) => (overrides[k] ?? SAMPLE[k]));

let covered = 0;
for (const [en, es] of RULES) {
  assert.equal(placeholders(en), placeholders(es), `placeholders differ between English and Spanish: ${en}`);
  const english = fill(en);
  const expected = fill(es, { time: esTime(SAMPLE.time) });
  assert.equal(translateText(english), expected, `wrong translation for: ${en}`);
  assert.notEqual(translateText(english), english, `not translated: ${en}`);
  covered += 1;
}

assert.equal(esTime("Oct 4, 2:00 PM EDT"), "4 oct, 2:00 p. m. EDT");
assert.equal(esTime("Dec 25, 9:30 AM PST"), "25 dic, 9:30 a. m. PST");
assert.equal(esTime("something else"), "something else");

// a real outbid email, end to end
const out = translateEmailParts("es", {
  subject: "You've been outbid on Red Coral",
  heading: "You've been outbid!",
  lines: ["Hey there,", "We're letting you know you've been outbid on \"Red Coral\". The current bid is now $12.50.", "The auction ends Oct 4, 2:00 PM EDT, so jump back in and raise your bid before time runs out."],
  buttonLabel: "Bid Again Now",
});
assert.equal(out.subject, "Te han superado en Red Coral");
assert.equal(out.heading, "¡Te han superado!");
assert.equal(out.lines[0], "Hola,");
assert.ok(out.lines[1].includes("\"Red Coral\"") && out.lines[1].includes("$12.50"));
assert.ok(out.lines[2].includes("4 oct, 2:00 p. m. EDT"));
assert.equal(out.buttonLabel, "Pujar de nuevo");

// anything unknown, merchant emails and English buyers stay exactly as they are
assert.equal(translateText("The winner hasn't paid"), "The winner hasn't paid");
assert.equal(translateText("Open Hellfire Auctions"), "Open Hellfire Auctions");
const same = { subject: "s", heading: "h", lines: ["Hey there,"], buttonLabel: "Bid now" };
assert.deepEqual(translateEmailParts("en", same), same);
assert.equal(translateEmailParts("en", same), same);
assert.equal(translateText(undefined), undefined);

// titles with odd characters survive
assert.equal(translateText("You've been outbid on 50% off $$ (rare) [new] {x}"), "Te han superado en 50% off $$ (rare) [new] {x}");

assert.equal(normalizeLang("es"), "es");
assert.equal(normalizeLang("es-MX"), "es");
assert.equal(normalizeLang("ES"), "es");
assert.equal(normalizeLang("fr"), "en");
assert.equal(normalizeLang(undefined), "en");
assert.ok(footerWords("es").sent("Tienda").startsWith("Enviado por Tienda"));
assert.ok(footerWords("en").sent("Shop").startsWith("Sent by Shop"));

console.log(`Email translations: ${covered} rules all check out`);
