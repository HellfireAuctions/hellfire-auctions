// Live check of the new languages on the production server (the email preferences page speaks the shopper's language).
const https = require("https");
function get(path, headers = {}) {
  return new Promise((resolve) => {
    https.get("https://hellfire-auctions.onrender.com" + path, { headers }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ s: res.statusCode, b }));
    }).on("error", (e) => resolve({ s: 0, b: String(e) }));
  });
}
const cases = [
  ["Spanish (?l=es)", "/email-preferences?t=invalid&l=es", {}, "ya no es válido"],
  ["French (?l=fr)", "/email-preferences?t=invalid&l=fr", {}, "plus valide"],
  ["German (?l=de)", "/email-preferences?t=invalid&l=de", {}, "nicht mehr gültig"],
  ["Portuguese (?l=pt)", "/email-preferences?t=invalid&l=pt", {}, "mais válido"],
  ["Italian (?l=it)", "/email-preferences?t=invalid&l=it", {}, "non è più valido"],
  ["Dutch (?l=nl)", "/email-preferences?t=invalid&l=nl", {}, "niet meer geldig"],
  ["French from the browser's language (no ?l)", "/email-preferences?t=invalid", { "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.5" }, "plus valide"],
  ["German from the browser's language", "/email-preferences?t=invalid", { "Accept-Language": "de-DE,de;q=0.9" }, "nicht mehr gültig"],
  ["Swedish is not supported yet, so English", "/email-preferences?t=invalid&l=sv", {}, "valid anymore"],
  ["Italian from the browser's language", "/email-preferences?t=invalid", { "Accept-Language": "it-IT,it;q=0.9" }, "non è più valido"],
  ["Dutch from the browser's language", "/email-preferences?t=invalid", { "Accept-Language": "nl-NL,nl;q=0.9" }, "niet meer geldig"],
  ["No language at all: English", "/email-preferences?t=invalid", {}, "valid anymore"],
  ["Help Center lists the languages", "/help", {}, "Portuguese"],
  ["Pricing page lists the languages", "/pricing", {}, "Portuguese"],
  ["Server health", "/healthz", {}, ""],
];
(async () => {
  let ok = true;
  for (const [name, path, headers, needle] of cases) {
    const r = await get(path, headers);
    const pass = r.s >= 200 && r.s < 500 && (needle === "" || r.b.includes(needle)) && r.s !== 500;
    ok = ok && pass;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}: HTTP ${r.s}${needle && !r.b.includes(needle) ? " (expected text not found)" : ""}`);
  }
  console.log(ok ? "LIVE LANGUAGE CHECK: all good" : "LIVE LANGUAGE CHECK: PROBLEM");
})();
