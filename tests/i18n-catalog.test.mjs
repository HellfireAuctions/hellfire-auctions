import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const LANGS = ["es", "fr", "de", "pt", "it", "nl"];
const catalogs = Object.fromEntries(LANGS.map((l) => [l, new Map(require(`../i18n/${l}.cjs`))]));
const surfaces = JSON.parse(fs.readFileSync(new URL("../i18n/surfaces.json", import.meta.url), "utf8"));
const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(",");
const reference = catalogs.es;

assert.ok(reference.size >= 186, "the Spanish catalog is the reference and must hold every phrase");

for (const lang of LANGS) {
  const catalog = catalogs[lang];
  const missing = [...reference.keys()].filter((k) => !catalog.has(k));
  assert.deepEqual(missing, [], `${lang} is missing ${missing.length} phrase(s), for example: ${missing.slice(0, 2).join(" | ")}`);
  const extra = [...catalog.keys()].filter((k) => !reference.has(k));
  assert.deepEqual(extra, [], `${lang} has phrases the app doesn't use (a typo in the English side?): ${extra.slice(0, 2).join(" | ")}`);
  for (const [en, translation] of catalog) {
    assert.ok(typeof translation === "string" && translation.trim().length > 0, `${lang}: empty translation for: ${en}`);
    assert.equal(placeholders(translation), placeholders(en), `${lang}: the {placeholders} differ from English in: ${en}`);
    assert.ok(!/\{%|%\}|\{\{|\}\}/.test(translation), `${lang}: template-like text in: ${en}`);
    assert.ok(!/\$\{|`/.test(translation), `${lang}: code-like text in: ${en}`);
  }
  // phrases the My Auctions page's own script uses are placed inside a quoted string: no quotes or backslashes allowed
  for (const key of ["ended", "Preparing your invoice...", "Couldn't combine your wins. Please try again.", "Pay all wins together"]) {
    assert.ok(!/["\\]/.test(catalog.get(key)), `${lang}: quotes or backslashes in: ${key}`);
  }
}

// every phrase a part of the app uses exists in the catalog
for (const [surface, keys] of Object.entries(surfaces)) {
  for (const key of keys) assert.ok(reference.has(key), `${surface} uses a phrase that is not in the catalog: ${key}`);
}

// a language that is merely a copy of English would be a mistake (a few short words legitimately match)
for (const lang of LANGS) {
  const same = [...catalogs[lang]].filter(([en, tr]) => en === tr).length;
  assert.ok(same <= 8, `${lang}: ${same} phrases are identical to English; were they translated?`);
}

// the dictionaries embedded in the app are exactly what the catalogs say
execFileSync(process.execPath, ["scripts/apply-i18n.cjs", "--check"], { stdio: "inherit" });

console.log(`Translation catalogs: ${LANGS.join(", ")} each have all ${reference.size} phrases, with matching placeholders`);
