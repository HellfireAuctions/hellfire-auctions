// Pages returned to Shopify's app proxy are Liquid, so the store itself picks the shopper's language
// (request.locale) when it renders the page. Works for any number of languages.
//   P(en, { es: "...", fr: "..." })   one wording per language, English when no language matches
//   makeT(dictionaries)               T(en, vars) looks every language up in { es: {...}, fr: {...} }
export const LIQUID_LANG = "{% assign hf_lang = request.locale.iso_code | slice: 0, 2 %}";

const fill = (text, vars) => (vars ? Object.keys(vars).reduce((out, k) => out.split("{" + k + "}").join(String(vars[k])), text) : text);

export const P = (en, translations = {}) => {
  const branches = Object.entries(translations).filter(([, text]) => text !== en);
  if (!branches.length) return en;
  const chosen = branches.map(([lang, text], i) => `{% ${i ? "elsif" : "if"} hf_lang == '${lang}' %}${text}`).join("");
  return `${chosen}{% else %}${en}{% endif %}`;
};

export function makeT(dictionaries) {
  return (en, vars) => {
    const english = fill(en, vars);
    const translations = {};
    for (const [lang, dict] of Object.entries(dictionaries)) {
      if (Object.prototype.hasOwnProperty.call(dict, en)) translations[lang] = fill(dict[en], vars);
    }
    return P(english, translations);
  };
}
