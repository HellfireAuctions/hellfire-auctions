// Live Drops: the rules. A host shows items on video and sells them at a set price; the first people to claim win.
// Everything here is pure (no database), so it can be tested without one. The server applies these rules inside a
// row-locked transaction, which is what makes "first tap wins" exact.

export const MAX_DROPS = 200;
export const MAX_QUANTITY = 1000;
export const MAX_PER_PERSON = 50;
export const MAX_PRICE = 99999;

const cleanText = (value, max) => Array.from(String(value ?? "")).map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch)).join("").trim().slice(0, max);
const round2 = (n) => Math.round(n * 100) / 100;

// A drop = one item at one price in one quantity. Reads the host's form.
export function parseDrop(form) {
  const get = (key) => (typeof form?.get === "function" ? form.get(key) : form?.[key]);
  const title = cleanText(get("title"), 120);
  const variantId = String(get("variantId") || "").trim();
  const productId = String(get("productId") || "").trim();
  if (!title || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId) || !/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    return { ok: false, error: "Choose a product first." };
  }
  const price = round2(Number(get("price")));
  if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE) return { ok: false, error: `Enter a price between 0.01 and ${MAX_PRICE.toLocaleString("en-US")}.` };
  const quantity = Math.floor(Number(get("quantity")));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return { ok: false, error: `Quantity must be a whole number from 1 to ${MAX_QUANTITY}.` };
  let perPerson = Math.floor(Number(get("perPerson") || 1));
  if (!Number.isFinite(perPerson) || perPerson < 1) perPerson = 1;
  perPerson = Math.min(perPerson, quantity, MAX_PER_PERSON);
  const image = String(get("imageUrl") || "").trim();
  return { ok: true, drop: { title, variantId, productId, imageUrl: /^https:\/\/[^\s]{4,2000}$/.test(image) ? image : null, price, quantity, perPerson } };
}

export const remaining = (drop) => Math.max(0, Number(drop.quantity) - Number(drop.claimed));

// Can this person claim right now? \`already\` is how many they hold of this item. Called inside the locked transaction.
export function claimDecision({ saleStatus, drop, already = 0, want = 1 }) {
  if (saleStatus !== "LIVE") return { ok: false, code: "NOT_LIVE", message: "This show isn't live right now." };
  if (!drop || drop.status !== "OPEN") return { ok: false, code: "NOT_OPEN", message: "This item isn't open for claiming." };
  const left = remaining(drop);
  if (left <= 0) return { ok: false, code: "SOLD_OUT", message: "Sold out. Someone was faster." };
  const room = Number(drop.perPerson) - Number(already);
  if (room <= 0) return { ok: false, code: "LIMIT", message: `You already have the limit of ${drop.perPerson} for this item.` };
  const quantity = Math.max(1, Math.min(Math.floor(Number(want)) || 1, left, room));
  return { ok: true, quantity, soldOutAfter: left - quantity <= 0 };
}

// Can the host open this item?
export function openDecision({ saleStatus, drop }) {
  if (saleStatus !== "LIVE") return { ok: false, message: "Start the show first." };
  if (!drop) return { ok: false, message: "That item no longer exists." };
  if (drop.status === "OPEN") return { ok: false, message: "That item is already open." };
  if (remaining(drop) <= 0) return { ok: false, message: "That item is sold out." };
  return { ok: true };
}

// What a shopper sees. Nothing about other shoppers is ever included.
export function roomView({ sale, drops, myClaims = [] }) {
  const sorted = [...(drops || [])].sort((a, b) => a.position - b.position);
  const open = sorted.find((d) => d.status === "OPEN") || null;
  const heldByDrop = new Map();
  for (const c of myClaims) heldByDrop.set(c.dropId, (heldByDrop.get(c.dropId) || 0) + Number(c.quantity));
  const brief = (d) => ({ id: d.id, title: d.title, imageUrl: d.imageUrl || null, price: Number(d.price), quantity: d.quantity, remaining: remaining(d), perPerson: d.perPerson });
  const phase = sale.status === "ENDED" ? "ended" : sale.status === "DRAFT" ? "before" : open ? "open" : "between";
  const mine = sorted.filter((d) => heldByDrop.has(d.id)).map((d) => ({ title: d.title, price: Number(d.price), quantity: heldByDrop.get(d.id) }));
  return {
    title: sale.title,
    status: sale.status,
    phase,
    open: open ? { ...brief(open), mine: heldByDrop.get(open.id) || 0 } : null,
    upcoming: sorted.filter((d) => d.status === "QUEUED").slice(0, 6).map((d) => ({ title: d.title, imageUrl: d.imageUrl || null, price: Number(d.price), quantity: d.quantity })),
    results: sorted.filter((d) => d.status === "CLOSED").slice(-8).reverse().map((d) => ({ title: d.title, price: Number(d.price), quantity: d.quantity, claimed: d.claimed, soldOut: remaining(d) <= 0 })),
    mine,
    mineTotal: round2(mine.reduce((sum, m) => sum + m.price * m.quantity, 0)),
    version: `${sale.status}:${open ? `${open.id}:${open.claimed}` : "-"}:${sorted.map((d) => `${d.status[0]}${d.claimed}`).join("")}`,
  };
}

// One invoice per shopper: every claim, combined, at the show prices.
export function invoiceLines({ claims, drops }) {
  const order = new Map((drops || []).map((d, i) => [d.id, i]));
  const byId = new Map((drops || []).map((d) => [d.id, d]));
  const held = new Map();
  for (const c of claims || []) held.set(c.dropId, (held.get(c.dropId) || 0) + Number(c.quantity));
  const lines = [];
  for (const [dropId, quantity] of held) {
    const d = byId.get(dropId);
    if (d) lines.push({ dropId, variantId: d.variantId, title: d.title, price: Number(d.price), quantity });
  }
  lines.sort((a, b) => order.get(a.dropId) - order.get(b.dropId));
  return { lines, total: round2(lines.reduce((sum, l) => sum + l.price * l.quantity, 0)) };
}
