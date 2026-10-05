import assert from "node:assert/strict";
import { P, makeT, LIQUID_LANG } from "../app/liquid-i18n.js";

const T = makeT({
  es: { "Pay now": "Pagar ahora", "You have {n} unpaid wins": "Tienes {n} victorias sin pagar", Minimum: "Mínimo" },
  fr: { "Pay now": "Payer maintenant", "You have {n} unpaid wins": "Vous avez {n} enchères à payer", Minimum: "Minimum" },
});
const balanced = (s) => (s.match(/{% if /g) || []).length === (s.match(/{% endif %}/g) || []).length;

// one branch per language, English last
assert.equal(T("Pay now"), "{% if hf_lang == 'es' %}Pagar ahora{% elsif hf_lang == 'fr' %}Payer maintenant{% else %}Pay now{% endif %}");
assert.equal(
  T("You have {n} unpaid wins", { n: 3 }),
  "{% if hf_lang == 'es' %}Tienes 3 victorias sin pagar{% elsif hf_lang == 'fr' %}Vous avez 3 enchères à payer{% else %}You have 3 unpaid wins{% endif %}",
);

// a language whose wording equals English gets no branch; unknown text passes through untouched
assert.equal(T("Minimum"), "{% if hf_lang == 'es' %}Mínimo{% else %}Minimum{% endif %}");
assert.equal(T("Not translated yet"), "Not translated yet");

// P: explicit wording per language
assert.equal(P("same", { es: "same" }), "same");
assert.equal(P("", { es: "Quedan ", fr: "Il reste " }), "{% if hf_lang == 'es' %}Quedan {% elsif hf_lang == 'fr' %}Il reste {% else %}{% endif %}");
assert.equal(P(" left", { es: "", fr: "" }), "{% if hf_lang == 'es' %}{% elsif hf_lang == 'fr' %}{% else %} left{% endif %}");
assert.equal(P("x"), "x");
assert.equal(P("x", {}), "x");

// every generated chain is balanced, and the page sets the language once
for (const out of [T("Pay now"), T("You have {n} unpaid wins", { n: 1 }), P("a", { es: "b", fr: "c", de: "d", pt: "e" })]) assert.ok(balanced(out), out);
assert.ok(LIQUID_LANG.includes("request.locale.iso_code") && LIQUID_LANG.includes("hf_lang") && !LIQUID_LANG.includes("{% if"));

console.log("Liquid wording helper: all checks passed");
