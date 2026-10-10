import prisma from "../db.server";
import { memoDelete } from "../memo.server";
import { publish } from "../live-hub.server";
import { verifyStudioToken } from "../studio-token.server";
import { goLiveEnabled } from "../go-live";
import { streamConfigured } from "../cloudflare-stream.server";
import { openDrop, closeOpenDrop } from "../action-sale.server";
import { startStream, stopStream, beatStream, openNextDrop } from "../stream-control.server";

// The Live Studio's data and controls. Every request carries the signed link the admin handed out (good for one show,
// four hours), so this page needs no Shopify login. It can run that show's video and items, and nothing else.

const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function authorize(request, form) {
  const url = new URL(request.url);
  const token = (form && form.get("t")) || url.searchParams.get("t") || "";
  const verdict = verifyStudioToken(token, process.env.SHOPIFY_API_SECRET);
  if (!verdict.ok) return { error: reply({ ok: false, message: "This Studio link has expired. Open the Studio again from the app." }, 401) };
  if (!goLiveEnabled(verdict.shop, process.env.GOLIVE_SHOPS) || !streamConfigured()) return { error: reply({ ok: false, message: "Go Live isn't switched on for this store." }, 403) };
  return { shop: verdict.shop, saleId: verdict.saleId };
}

const touch = (saleId) => {
  memoDelete("action:" + saleId);
  publish("sale-" + saleId, "update");
};

export const loader = async ({ request }) => {
  const auth = await authorize(request, null);
  if (auth.error) return auth.error;
  const sale = await prisma.actionSale.findFirst({ where: { id: auth.saleId, shop: auth.shop }, include: { drops: { orderBy: { position: "asc" } } } });
  if (!sale) return reply({ ok: false, message: "That show wasn't found." }, 404);
  const buyers = (await prisma.actionClaim.findMany({ where: { saleId: sale.id }, select: { customerId: true }, distinct: ["customerId"] })).length;
  return reply({
    ok: true,
    title: sale.title,
    status: sale.status,
    streaming: sale.streaming,
    room: 'https://' + auth.shop + '/apps/hellfire-auctions/live?sale=' + sale.id,
    buyers,
    drops: sale.drops.map((d) => ({ id: d.id, title: d.title, imageUrl: d.imageUrl, price: d.price, quantity: d.quantity, claimed: d.claimed, perPerson: d.perPerson, status: d.status })),
  });
};

export const action = async ({ request }) => {
  const form = await request.formData();
  const auth = await authorize(request, form);
  if (auth.error) return auth.error;
  const { shop, saleId } = auth;
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "start") {
      const started = await startStream({ shop, saleId });
      if (started.ok) touch(saleId);
      return reply(started, started.ok ? 200 : 409);
    }
    if (intent === "stop") {
      await stopStream({ shop, saleId });
      touch(saleId);
      return reply({ ok: true });
    }
    if (intent === "start-show") {
      const sale = await prisma.actionSale.findFirst({ where: { id: saleId, shop }, select: { status: true } });
      if (!sale) return reply({ ok: false, message: "That show wasn't found." }, 404);
      if (sale.status === "ENDED") return reply({ ok: false, message: "This show has ended." }, 409);
      if (sale.status === "LIVE") return reply({ ok: true });
      if (!(await prisma.actionDrop.count({ where: { saleId } }))) return reply({ ok: false, message: "Add at least one item to the show first (in the app)." }, 409);
      await prisma.actionSale.update({ where: { id: saleId }, data: { status: "LIVE", lastActivityAt: new Date() } });
      touch(saleId);
      return reply({ ok: true, message: "The show is live." });
    }
    if (intent === "resume") {
      const sale = await prisma.actionSale.findFirst({ where: { id: saleId, shop }, select: { status: true } });
      if (!sale) return reply({ ok: false, message: "That show wasn't found." }, 404);
      if (sale.status !== "ENDED") return reply({ ok: true });
      await prisma.actionSale.update({ where: { id: saleId }, data: { status: "LIVE", endedAt: null, lastActivityAt: new Date() } });
      touch(saleId);
      return reply({ ok: true, message: "The show is live again." });
    }
    if (intent === "beat") return reply(await beatStream({ shop, saleId }));
    if (intent === "go") {
      const sale = await prisma.actionSale.findFirst({ where: { id: saleId, shop }, select: { id: true } });
      if (!sale) return reply({ ok: false, message: "That show wasn't found." }, 404);
      const opened = await openDrop({ shop, saleId, dropId: String(form.get("dropId") || "") });
      if (opened.ok) touch(saleId);
      return reply(opened, opened.ok ? 200 : 409);
    }
    if (intent === "close") {
      const closed = await closeOpenDrop({ shop, saleId });
      if (closed.ok) touch(saleId);
      return reply(closed, closed.ok ? 200 : 409);
    }
    if (intent === "next") {
      const next = await openNextDrop({ shop, saleId });
      if (next.ok) touch(saleId);
      return reply(next, next.ok ? 200 : 409);
    }
  } catch (error) {
    console.error("[HELLFIRE LIVE DROPS] studio request failed:", intent, error?.message || error);
    return reply({ ok: false, message: "Something went wrong. Please try again." }, 500);
  }
  return reply({ ok: false, message: "Unknown request." }, 400);
};
