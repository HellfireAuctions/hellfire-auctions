import prisma from "./db.server.js";
import { createLiveInput, deleteLiveInput } from "./cloudflare-stream.server.js";
import { openDrop, closeOpenDrop } from "./action-sale.server.js";
import { remaining } from "./action-sale.js";

// Go Live: the lifecycle of a show's video channel. One private channel per show, created the first time the host starts
// streaming, kept while the host's Studio tab keeps checking in, and removed when the show ends or is deleted.

export async function startStream({ shop, saleId, db = prisma, create = createLiveInput }) {
  const sale = await db.actionSale.findFirst({ where: { id: saleId, shop } });
  if (!sale) return { ok: false, message: "That show wasn't found." };
  if (sale.status === "ENDED") return { ok: false, message: "This show has ended." };
  let { streamUid, streamPublishUrl, streamPlayUrl } = sale;
  if (!streamUid || !streamPublishUrl || !streamPlayUrl) {
    const made = await create({ name: sale.title });
    streamUid = made.uid;
    streamPublishUrl = made.publishUrl;
    streamPlayUrl = made.playUrl;
  }
  const now = new Date();
  await db.actionSale.update({
    where: { id: saleId },
    data: { streamUid, streamPublishUrl, streamPlayUrl, streaming: true, streamStartedAt: sale.streaming && sale.streamStartedAt ? sale.streamStartedAt : now, streamBeatAt: now, lastActivityAt: now },
  });
  return { ok: true, publishUrl: streamPublishUrl };
}

// The host pressed Stop. The channel is kept so they can start again; viewers see "back soon".
export async function stopStream({ shop, saleId, db = prisma }) {
  await db.actionSale.updateMany({ where: { id: saleId, shop }, data: { streaming: false, streamStartedAt: null, streamBeatAt: null, lastActivityAt: new Date() } });
  return { ok: true };
}

// The Studio tab checks in every few seconds; silence for 30 seconds means the host has left.
export async function beatStream({ shop, saleId, db = prisma }) {
  const result = await db.actionSale.updateMany({ where: { id: saleId, shop, streaming: true }, data: { streamBeatAt: new Date(), lastActivityAt: new Date() } });
  return { ok: result.count > 0 };
}

// The show is over (or deleted): shut the channel down for good so nothing is left running or billed.
export async function releaseStream({ shop, saleId, db = prisma, remove = deleteLiveInput }) {
  const sale = await db.actionSale.findFirst({ where: { id: saleId, shop }, select: { streamUid: true } });
  if (!sale) return { ok: false };
  if (sale.streamUid) await remove(sale.streamUid);
  await db.actionSale.updateMany({ where: { id: saleId, shop }, data: { streaming: false, streamUid: null, streamPublishUrl: null, streamPlayUrl: null, streamStartedAt: null, streamBeatAt: null } });
  return { ok: true };
}

// Close whatever is open and open the next waiting item.
export async function openNextDrop({ shop, saleId, db = prisma, open = openDrop, close = closeOpenDrop }) {
  const queue = await db.actionDrop.findMany({ where: { saleId, shop }, orderBy: { position: "asc" } });
  const next = queue.find((d) => d.status === "QUEUED" && remaining(d) > 0);
  await close({ shop, saleId });
  if (!next) return { ok: true, message: "Closed. There are no more items waiting." };
  const opened = await open({ shop, saleId, dropId: next.id });
  return opened.ok ? { ok: true, message: `Now selling: ${next.title}` } : opened;
}
