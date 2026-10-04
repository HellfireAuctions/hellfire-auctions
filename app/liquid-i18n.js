// Pages returned to Shopify's app proxy are Liquid, so the store itself picks the shopper's language.
// P(en, es) gives one wording per language; T(en, vars) looks the Spanish up in a dictionary.
export const LIQUID_LANG = "{% assign hf_lang = request.locale.iso_code | slice: 0, 2 %}{% assign hf_es = false %}{% if hf_lang == 'es' %}{% assign hf_es = true %}{% endif %}";

const fill = (text, vars) => (vars ? Object.keys(vars).reduce((out, k) => out.split("{" + k + "}").join(String(vars[k])), text) : text);

export const P = (en, es) => (en === es ? en : "{% if hf_es %}" + es + "{% else %}" + en + "{% endif %}");

export function makeT(dictionary) {
  return (en, vars) => {
    const english = fill(en, vars);
    const spanish = Object.prototype.hasOwnProperty.call(dictionary, en) ? fill(dictionary[en], vars) : english;
    return P(english, spanish);
  };
}
