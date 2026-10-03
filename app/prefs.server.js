import crypto from "node:crypto";
import prisma from "./db.server.js";

// Optional email categories a customer can switch off. Winner, invoice and payment emails always send.
const secret = () => process.env.SHOPIFY_API_SECRET || "dev-only-secret";
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const mac = (payload) => b64(crypto.createHmac("sha256", secret()).update("prefs|" + payload).digest()).slice(0, 32);

export function signPrefs(shop, customerId) {
  const payload = b64(`${shop}|${customerId}`);
  return `${payload}.${mac(payload)}`;
}

export function readPrefsToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = mac(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [shop, customerId] = Buffer.from(payload, "base64url").toString("utf8").split("|");
  return shop && customerId ? { shop, customerId } : null;
}

export function prefsUrl(shop, customerId) {
  const base = (process.env.SHOPIFY_APP_URL || "https://hellfire-auctions.onrender.com").replace(/\/$/, "");
  return `${base}/email-preferences?t=${signPrefs(shop, customerId)}`;
}

export async function getPrefs(shop, customerId) {
  const row = await prisma.notificationPref.findUnique({ where: { shop_customerId: { shop, customerId: String(customerId) } } });
  return { outbid: row?.outbid ?? true, reminders: row?.reminders ?? true, results: row?.results ?? true };
}

export async function savePrefs(shop, customerId, prefs) {
  const data = { outbid: Boolean(prefs.outbid), reminders: Boolean(prefs.reminders), results: Boolean(prefs.results) };
  await prisma.notificationPref.upsert({
    where: { shop_customerId: { shop, customerId: String(customerId) } },
    create: { shop, customerId: String(customerId), ...data },
    update: data,
  });
  return data;
}

export async function prefsAllow(shop, customerId, category) {
  const prefs = await getPrefs(shop, customerId);
  return prefs[category] !== false;
}
