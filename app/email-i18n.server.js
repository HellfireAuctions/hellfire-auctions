// Spanish for buyer-facing emails. Each rule is an English sentence with {placeholders} and its Spanish twin.
// Anything that doesn't match a rule is sent unchanged in English, so a new email can never break.

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ES_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// "Oct 4, 2:00 PM EDT" -> "4 oct, 2:00 p. m. EDT"
export function esTime(text) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (.+)$/.exec(text);
  if (!m) return text;
  const i = EN_MONTHS.indexOf(m[1]);
  if (i < 0) return text;
  return `${m[2]} ${ES_MONTHS[i]}, ${m[3].replace(/ AM\b/, " a. m.").replace(/ PM\b/, " p. m.")}`;
}

export function normalizeLang(locale) {
  return String(locale || "").slice(0, 2).toLowerCase() === "es" ? "es" : "en";
}

export const RULES = [
  // outbid
  ["You've been outbid on {title}", "Te han superado en {title}"],
  ["You've been outbid!", "¡Te han superado!"],
  ["Hey there,", "Hola,"],
  ["We're letting you know you've been outbid on \"{title}\". The current bid is now {money}.", "Te avisamos de que te han superado en \"{title}\". La puja actual es ahora {money}."],
  ["The auction ends {time}, so jump back in and raise your bid before time runs out.", "La subasta termina el {time}. Vuelve a pujar antes de que se acabe el tiempo."],
  ["Bid Again Now", "Pujar de nuevo"],
  // one hour left (bidders and watchers)
  ["1 hour left: {title}", "Queda 1 hora: {title}"],
  ["Less than 1 hour left", "Queda menos de 1 hora"],
  ["The auction for \"{title}\" ends at {time}, in under an hour. The current bid is {money}.", "La subasta de \"{title}\" termina el {time}, en menos de una hora. La puja actual es {money}."],
  ["You're currently the high bidder. Keep watching in case someone outbids you.", "Ahora mismo eres el mejor postor. Sigue atento por si alguien te supera."],
  ["You're not the high bidder right now. Bid again before time runs out.", "Ahora mismo no eres el mejor postor. Vuelve a pujar antes de que se acabe el tiempo."],
  ["Watch the auction", "Seguir la subasta"],
  ["Bid again", "Pujar de nuevo"],
  ["The auction you're watching, \"{title}\", ends at {time}, in under an hour. The current bid is {money}.", "La subasta que sigues, \"{title}\", termina el {time}, en menos de una hora. La puja actual es {money}."],
  ["Bid now", "Pujar ahora"],
  // winner
  ["A second chance to buy \"{title}\" at {shop}", "Una segunda oportunidad para comprar \"{title}\" en {shop}"],
  ["You won the auction at {shop}!", "¡Ganaste la subasta en {shop}!"],
  ["A second chance to buy", "Una segunda oportunidad de compra"],
  ["You won the auction!", "¡Ganaste la subasta!"],
  ["Good news!", "¡Buenas noticias!"],
  ["The original winner didn't complete the purchase, so \"{title}\" is now offered to you at {money}.", "El ganador original no completó la compra, así que \"{title}\" ahora se te ofrece a {money}."],
  ["Use the secure checkout link below to buy it. Please pay within 4 days.", "Usa el enlace de pago seguro de abajo para comprarlo. Por favor, paga en un plazo de 4 días."],
  ["Congratulations! You won \"{title}\" with a winning bid of {money}.", "¡Felicidades! Ganaste \"{title}\" con una puja ganadora de {money}."],
  ["Use the secure checkout link below to complete your purchase. Please pay within 4 days. At checkout you can choose from all of the shipping options the store offers.", "Usa el enlace de pago seguro de abajo para completar tu compra. Por favor, paga en un plazo de 4 días. Al pagar puedes elegir entre todas las opciones de envío que ofrece la tienda."],
  ["You have other recent wins. To pay for everything at once and pay shipping once, open your My Auctions page: {url}", "Tienes otras victorias recientes. Para pagar todo de una vez y pagar el envío una sola vez, abre tu página Mis subastas: {url}"],
  ["Complete your purchase", "Completar tu compra"],
  // payment reminder
  ["Reminder: complete your purchase of {title}", "Recordatorio: completa tu compra de {title}"],
  ["Your purchase is waiting", "Tu compra te está esperando"],
  ["You won {n} items ({money} in total), and your combined purchase isn't complete yet.", "Ganaste {n} artículos ({money} en total) y tu compra combinada aún no está completa."],
  ["You won \"{title}\" with a winning bid of {money}, but your purchase isn't complete yet.", "Ganaste \"{title}\" con una puja ganadora de {money}, pero tu compra aún no está completa."],
  ["Please pay by {time} so the seller can ship it to you.", "Por favor, paga antes del {time} para que el vendedor pueda enviártelo."],
  // did not win
  ["Auction ended: {title}", "Subasta terminada: {title}"],
  ["This auction has ended", "Esta subasta ha terminado"],
  ["\"{title}\" sold for {money}, so your bid didn't win this time.", "\"{title}\" se vendió por {money}, así que tu puja no ganó esta vez."],
  ["Thanks for bidding. There may be more auctions running right now.", "Gracias por pujar. Puede que haya más subastas en marcha ahora mismo."],
  ["See live auctions", "Ver subastas en vivo"],
  // reserve not met
  ["Auction ended: reserve not met \u2014 {title}", "Subasta terminada: no se alcanzó la reserva \u2014 {title}"],
  ["The reserve wasn't met", "No se alcanzó el precio de reserva"],
  ["The auction for \"{title}\" has ended. You were the highest bidder at {money}, but the seller's reserve price wasn't met, so there's no sale and you won't be charged.", "La subasta de \"{title}\" ha terminado. Eras el mejor postor con {money}, pero no se alcanzó el precio de reserva del vendedor, así que no hay venta y no se te cobrará."],
  ["Keep an eye on the store in case the seller relists it.", "Mantente atento a la tienda por si el vendedor la vuelve a publicar."],
  ["Visit the store", "Visitar la tienda"],
  // watcher: started
  ["Now live: {title}", "Ya en vivo: {title}"],
  ["The auction you're watching has started", "La subasta que sigues ha comenzado"],
  ["\"{title}\" is live now at {money}. It ends {time}.", "\"{title}\" ya está en vivo a {money}. Termina el {time}."],
  // combined invoice
  ["Your {n} items are on one invoice", "Tus {n} artículos están en una sola factura"],
  ["One invoice for all your wins", "Una sola factura para todas tus victorias"],
  ["We combined your {n} unpaid wins into one invoice ({money} before shipping and tax), so you only pay shipping once.", "Combinamos tus {n} victorias sin pagar en una sola factura ({money} antes de envío e impuestos), así solo pagas el envío una vez."],
  ["Your earlier separate invoice links no longer work. Please use the button below and pay within 4 days.", "Tus enlaces de factura anteriores ya no funcionan. Usa el botón de abajo y paga en un plazo de 4 días."],
  ["Pay all wins together", "Pagar todas las victorias juntas"],
  // another win joined the invoice
  ["Added to your invoice: {title}", "Añadido a tu factura: {title}"],
  ["Another win added to your invoice", "Otra victoria añadida a tu factura"],
  ["You won \"{title}\". We added it to your open invoice, so you pay shipping only once.", "Ganaste \"{title}\". Lo añadimos a tu factura abierta, así pagas el envío solo una vez."],
  ["Your invoice now has {n} items ({money} before shipping and tax). Your 4-day payment window restarted today.", "Tu factura ahora tiene {n} artículos ({money} antes de envío e impuestos). Tu plazo de pago de 4 días se reinició hoy."],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile([en, es]) {
  const names = [];
  const pattern = en
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (m) {
        names.push(m[1]);
        return "(.+?)";
      }
      return escapeRe(part);
    })
    .join("");
  return { re: new RegExp("^" + pattern + "$", "s"), names, es };
}

// Most specific wording first: "Auction ended: reserve not met \u2014 {title}" must win over "Auction ended: {title}".
const literalLength = (en) => en.replace(/\{\w+\}/g, "").length;
const COMPILED = RULES.map((rule) => ({ ...compile(rule), weight: literalLength(rule[0]) })).sort((a, b) => b.weight - a.weight);

export function placeholders(text) {
  return (String(text).match(/\{\w+\}/g) || []).sort().join(",");
}

export function translateText(text) {
  if (typeof text !== "string") return text;
  for (const rule of COMPILED) {
    const m = rule.re.exec(text);
    if (!m) continue;
    let out = rule.es;
    rule.names.forEach((name, i) => {
      const value = name === "time" ? esTime(m[i + 1]) : m[i + 1];
      out = out.split("{" + name + "}").join(value);
    });
    return out;
  }
  return text;
}

export function translateEmailParts(lang, parts) {
  if (lang !== "es") return parts;
  return {
    subject: translateText(parts.subject),
    heading: translateText(parts.heading),
    lines: (parts.lines || []).map(translateText),
    buttonLabel: translateText(parts.buttonLabel),
  };
}

export function footerWords(lang) {
  return lang === "es"
    ? { sent: (shop) => `Enviado por ${shop} a través de Hellfire Auctions porque pujaste en esta subasta.`, manage: "Administra los emails que recibes" }
    : { sent: (shop) => `Sent by ${shop} via Hellfire Auctions because you bid on this auction.`, manage: "Manage the emails you get" };
}
