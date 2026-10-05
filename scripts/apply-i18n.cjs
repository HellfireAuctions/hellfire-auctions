// Rebuilds every embedded dictionary from the master catalogs in i18n/ (one file per language).
//   node scripts/apply-i18n.cjs           writes the dictionaries into the app
//   node scripts/apply-i18n.cjs --check   fails if any dictionary is out of date (used by the tests)
// To add a language: create i18n/<code>.cjs with a translation for every phrase in i18n/es.cjs, add its code to LANGS
// below, and run this script.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LANGS = ["es", "fr", "de", "pt", "it", "nl"];
const A = "extensions/hellfire-auctions-storefront/assets/";

const surfaces = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n", "surfaces.json"), "utf8"));
const catalogs = {};
for (const lang of LANGS) {
  const file = path.join(ROOT, "i18n", lang + ".cjs");
  if (fs.existsSync(file)) catalogs[lang] = new Map(require(file));
}
const langs = Object.keys(catalogs);

function dictsFor(name) {
  const out = {};
  for (const lang of langs) {
    out[lang] = {};
    for (const key of surfaces[name]) {
      if (!catalogs[lang].has(key)) throw new Error(`${lang} has no translation for: ${key}`);
      out[lang][key] = catalogs[lang].get(key);
    }
  }
  return out;
}

// The My Auctions page runs a few messages in its own script, chosen by Liquid from the shopper's language.
function hfChain() {
  const keys = { ended: "ended", preparing: "Preparing your invoice...", fail: "Couldn't combine your wins. Please try again.", combine: "Pay all wins together" };
  const obj = (lang) =>
    "{ " +
    Object.entries(keys)
      .map(([k, en]) => {
        const text = lang === "en" ? en : catalogs[lang].get(en);
        if (/["\\`]|\$\{/.test(text)) throw new Error(`these four messages cannot contain quotes or backslashes: ${text}`);
        return `${k}: "${text}"`;
      })
      .join(", ") +
    " }";
  let chain = "";
  langs.forEach((lang, i) => {
    chain += `{% ${i ? "elsif" : "if"} hf_lang == '${lang}' %}${obj(lang)}`;
  });
  return chain + `{% else %}${obj("en")}{% endif %}`;
}

const TARGETS = [
  { marker: "I18N:panel", file: A + "auction.js", make: () => `var TR=${JSON.stringify(dictsFor("panel"))};` },
  { marker: "I18N:cards", file: A + "auction-cards.js", make: () => `const TR = ${JSON.stringify(dictsFor("cards"))};` },
  { marker: "I18N:block", file: A + "live-auctions.js", make: () => `var TR = ${JSON.stringify(dictsFor("block"))};` },
  { marker: "I18N:myauctions", file: "app/routes/api.proxy.my-auctions.jsx", make: () => `const DICT = ${JSON.stringify(dictsFor("myauctions"), null, 2)};` },
  { marker: "I18N-HF", file: "app/routes/api.proxy.my-auctions.jsx", make: () => hfChain() },
  { marker: "I18N:prefs", file: "app/routes/email-preferences.jsx", make: () => `const DICT = ${JSON.stringify(dictsFor("prefs"), null, 2)};` },
  { marker: "I18N:emails", file: "app/email-i18n.server.js", make: () => `export const DICT = ${JSON.stringify(dictsFor("emails"), null, 2)};` },
];

const check = process.argv.includes("--check");
const contents = {};
let stale = 0;
for (const { marker, file, make } of TARGETS) {
  const abs = path.join(ROOT, file);
  let text = contents[file] ?? fs.readFileSync(abs, "utf8");
  const crlf = text.includes("\r\n");
  text = text.replace(/\r\n/g, "\n");
  const re = new RegExp(`/\\*${marker}\\*/[\\s\\S]*?/\\*END\\*/`);
  if (!re.test(text)) throw new Error(`marker ${marker} not found in ${file}`);
  const next = text.replace(re, () => `/*${marker}*/${make()}/*END*/`);
  if (next !== text) stale += 1;
  contents[file] = crlf ? next.replace(/\n/g, "\r\n") : next;
}
if (check) {
  if (stale) {
    console.error(`i18n check: ${stale} embedded dictionar${stale === 1 ? "y is" : "ies are"} out of date. Run: node scripts/apply-i18n.cjs`);
    process.exit(1);
  }
  console.log("i18n check: every embedded dictionary matches the catalogs (" + langs.join(", ") + ")");
} else {
  for (const [file, text] of Object.entries(contents)) fs.writeFileSync(path.join(ROOT, file), text, "utf8");
  console.log("i18n: dictionaries written for " + langs.join(", ") + " (" + TARGETS.length + " places)");
}
