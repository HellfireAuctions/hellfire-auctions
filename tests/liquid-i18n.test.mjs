import assert from "node:assert/strict";
import { P, makeT, LIQUID_LANG } from "../app/liquid-i18n.js";

const T = makeT({ "Pay now": "Pagar ahora", "You have {n} unpaid wins": "Tienes {n} victorias sin pagar" });
const balanced = (s) => (s.match(/{% if /g) || []).length === (s.match(/{% endif %}/g) || []).length;

assert.equal(T("Pay now"), "{% if hf_es %}Pagar ahora{% else %}Pay now{% endif %}");
assert.equal(T("You have {n} unpaid wins", { n: 3 }), "{% if hf_es %}Tienes 3 victorias sin pagar{% else %}You have 3 unpaid wins{% endif %}");
assert.equal(T("Not translated yet"), "Not translated yet", "unknown text passes through untouched");
assert.equal(P("same", "same"), "same");
assert.equal(P("", "Quedan "), "{% if hf_es %}Quedan {% else %}{% endif %}");
assert.ok(balanced(T("Pay now")) && balanced(T("You have {n} unpaid wins", { n: 1 })));
assert.ok(LIQUID_LANG.includes("request.locale.iso_code") && balanced(LIQUID_LANG));
console.log("Liquid wording helper: all checks passed");
