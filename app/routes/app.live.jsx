import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopPlan } from "../plans.server";
import { memoDelete } from "../memo.server";
import { publish } from "../live-hub.server";
import { LOT_DEFAULT, LOT_MIN, LOT_MAX, MAX_LOTS, parseLotSeconds, embedFor, startSale, startNextLot, skipLot, extendLot, endLot, endSale } from "../live-sale";

// Live Sale Mode: the host console. A sale is a queue of existing upcoming auctions that the host runs one at a time.
// Starting a lot makes that auction live right now; bidding, anti-sniping, winners and invoices are the normal auction flow.

const LOT_FIELDS = { id: true, productId: true, title: true, imageUrl: true, startingBid: true, currentBid: true, bidCount: true, reservePrice: true, startsAt: true, endsAt: true };

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const plan = await getShopPlan(shop);
  const now = new Date();
  const sales = await prisma.liveSale.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 8 });
  const ids = [...new Set(sales.flatMap((s) => s.lotIds))];
  const lots = ids.length ? await prisma.auction.findMany({ where: { shop, id: { in: ids } }, select: LOT_FIELDS }) : [];
  const taken = new Set(sales.filter((s) => s.status !== "ENDED").flatMap((s) => s.lotIds));
  const upcoming = await prisma.auction.findMany({
    where: { shop, startsAt: { gt: now }, bidCount: 0, status: { not: "CANCELLED" } },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: LOT_FIELDS,
  });
  return {
    allowed: plan.key === "INFERNO",
    shop,
    sales: sales.map((s) => ({ id: s.id, title: s.title, status: s.status, lotIds: s.lotIds, currentIndex: s.currentIndex, lotSeconds: s.lotSeconds, videoUrl: s.videoUrl })),
    lots,
    available: upcoming.filter((a) => !taken.has(a.id)),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const plan = await getShopPlan(shop);
  if (plan.key !== "INFERNO") return { error: "Live Sale Mode is part of the Inferno plan." };
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const now = new Date();

  if (intent === "create") {
    const title = String(form.get("title") || "").trim().slice(0, 80);
    if (!title) return { error: "Give the sale a title." };
    const videoUrl = String(form.get("videoUrl") || "").trim();
    if (videoUrl && !embedFor(videoUrl)) return { error: "That video link isn't supported. Use a YouTube, Vimeo, Facebook or Twitch link that starts with https://" };
    const picked = form.getAll("auctionId").map(String);
    if (!picked.length) return { error: "Choose at least one auction for the sale." };
    if (picked.length > MAX_LOTS) return { error: `A sale can have at most ${MAX_LOTS} lots.` };
    const valid = await prisma.auction.findMany({ where: { shop, id: { in: picked }, startsAt: { gt: now }, bidCount: 0 }, select: { id: true } });
    const okIds = new Set(valid.map((a) => a.id));
    if (picked.some((id) => !okIds.has(id))) return { error: "Some of the chosen auctions have already started or have bids. Reload the page and choose again." };
    await prisma.liveSale.create({ data: { shop, title, videoUrl: videoUrl || null, lotSeconds: parseLotSeconds(form.get("lotSeconds")), lotIds: picked } });
    return { success: "Sale created. Start it when you're ready to go live." };
  }

  const sale = await prisma.liveSale.findFirst({ where: { id: String(form.get("saleId") || ""), shop } });
  if (!sale) return { error: "That sale wasn't found." };
  const get = (id) => (id ? prisma.auction.findFirst({ where: { id, shop } }) : null);
  const current = sale.currentIndex >= 0 ? await get(sale.lotIds[sale.currentIndex]) : null;
  const next = await get(sale.lotIds[sale.currentIndex + 1]);

  if (intent === "delete") {
    if (sale.status === "LIVE") return { error: "End the sale before deleting it." };
    await prisma.liveSale.delete({ where: { id: sale.id } });
    return { success: "Sale deleted." };
  }

  let result;
  let target = current; // the auction this action changes
  if (intent === "start") result = startSale(sale);
  else if (intent === "next") {
    result = startNextLot({ sale, current, next, now });
    target = next;
  } else if (intent === "skip") result = skipLot({ sale, current, now });
  else if (intent === "extend") result = extendLot({ current, seconds: form.get("seconds"), now });
  else if (intent === "endlot") result = endLot({ current, now });
  else if (intent === "endsale") result = endSale({ sale, current, now });
  else return { error: "Unknown action." };
  if (!result.ok) return { error: result.error };

  if (result.auctionUpdate && target) await prisma.auction.update({ where: { id: target.id }, data: result.auctionUpdate });
  if (result.saleUpdate) await prisma.liveSale.update({ where: { id: sale.id }, data: result.saleUpdate });
  if (result.auctionUpdate && target) {
    memoDelete("auction:" + shop + "|" + target.productId); // everyone sees the change on their next refresh
    publish(target.id, "update");
  }
  memoDelete("sale:" + sale.id);
  publish("sale-" + sale.id, "update");
  console.log("[HELLFIRE LIVESALE]", JSON.stringify({ sale: sale.id, intent, lot: result.lotNumber || null }));

  const said = {
    start: "The sale is live. Start the first lot when you're ready.",
    next: result.finished ? "That was the last lot. The sale has ended." : `Lot ${result.lotNumber} is live.`,
    skip: "Skipped.",
    extend: "Added time to the lot.",
    endlot: "The lot has ended and will be settled in a moment.",
    endsale: "The sale has ended.",
  };
  return { success: said[intent] || "Done." };
};

function useNow(ms = 500) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const card = { border: "1px solid #d9d9d9", borderRadius: 12, padding: 16, background: "#fff", display: "grid", gap: 12 };
const input = { padding: "9px 12px", border: "1px solid #8a8a8a", borderRadius: 8, font: "inherit", width: "100%", boxSizing: "border-box" };
const btn = (primary) => ({ padding: "10px 16px", borderRadius: 8, border: primary ? "none" : "1px solid #8a8a8a", background: primary ? "#303030" : "#f6f6f7", color: primary ? "#fff" : "#303030", fontWeight: 600, cursor: "pointer", font: "inherit" });
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const time = (d) => new Date(d).getTime();

function Thumb({ src }) {
  return src ? (
    <img src={src} alt="" style={{ width: 48, height: 48, objectFit: "cover", aspectRatio: "1 / 1", borderRadius: 8, flex: "none" }} />
  ) : (
    <div style={{ width: 48, height: 48, borderRadius: 8, background: "#e3e3e3", flex: "none" }} />
  );
}

function Act({ saleId, intent, label, primary, disabled, extra }) {
  return (
    <Form method="post" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input type="hidden" name="saleId" value={saleId} />
      <input type="hidden" name="intent" value={intent} />
      {extra}
      <button type="submit" disabled={disabled} style={{ ...btn(primary), opacity: disabled ? 0.5 : 1 }}>
        {label}
      </button>
    </Form>
  );
}

function SaleCard({ sale, byId, shop, busy, now }) {
  const current = sale.currentIndex >= 0 ? byId.get(sale.lotIds[sale.currentIndex]) : null;
  const next = byId.get(sale.lotIds[sale.currentIndex + 1]);
  const running = Boolean(current) && time(current.startsAt) <= now && time(current.endsAt) > now;
  const left = running ? Math.max(0, Math.round((time(current.endsAt) - now) / 1000)) : 0;
  const link = `https://${shop}/apps/hellfire-auctions/live?sale=${sale.id}`;
  const live = sale.status === "LIVE";
  const remaining = sale.lotIds.length - (sale.currentIndex + 1);
  const statusColor = { DRAFT: "#616161", LIVE: "#b3261e", ENDED: "#616161" }[sale.status];

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <strong style={{ fontSize: 16 }}>{sale.title}</strong>{" "}
          <span style={{ color: statusColor, fontWeight: 700, fontSize: 12 }}>{live ? "● LIVE" : sale.status === "DRAFT" ? "NOT STARTED" : "ENDED"}</span>
          <div style={{ fontSize: 13, color: "#616161" }}>
            {sale.lotIds.length} lots, {sale.lotSeconds} seconds each{live ? `, ${remaining} still to run` : ""}
          </div>
        </div>
        <div style={{ fontSize: 13 }}>
          <a href={link} target="_blank" rel="noreferrer">Open the live room</a>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#616161", wordBreak: "break-all" }}>Share this link: {link}</div>

      {live && (
        <div style={{ border: "2px solid #303030", borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Now selling</div>
          {running ? (
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Thumb src={current.imageUrl} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>Lot {sale.currentIndex + 1}: {current.title}</div>
                <div style={{ fontSize: 13 }}>
                  {current.bidCount === 0 ? "No bids yet" : `${current.bidCount} bid${current.bidCount === 1 ? "" : "s"}, now ${money(current.currentBid)}`}
                </div>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }} aria-live="off">{mmss(left)}</div>
            </div>
          ) : current ? (
            <div style={{ fontSize: 14 }}>
              Lot {sale.currentIndex + 1} ({current.title}) {current.bidCount > 0 ? `sold for ${money(current.currentBid)}` : "ended without a bid"}.
            </div>
          ) : (
            <div style={{ fontSize: 14 }}>No lot has run yet.</div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Act saleId={sale.id} intent="next" label={next ? `Start lot ${sale.currentIndex + 2}: ${next.title.slice(0, 28)}` : "Finish the sale"} primary disabled={busy || running} />
            <Act saleId={sale.id} intent="extend" label="Add 30 seconds" disabled={busy || !running} extra={<input type="hidden" name="seconds" value="30" />} />
            <Act saleId={sale.id} intent="endlot" label="End this lot now" disabled={busy || !running} />
            <Act saleId={sale.id} intent="skip" label="Skip the next lot" disabled={busy || running || !next} />
            <Act saleId={sale.id} intent="endsale" label="End the sale" disabled={busy || running} />
          </div>
          {next && !running && (
            <div style={{ fontSize: 13, color: "#616161", display: "flex", gap: 8, alignItems: "center" }}>
              Up next: <Thumb src={next.imageUrl} /> {next.title} (starts at {money(next.startingBid)})
            </div>
          )}
        </div>
      )}

      {sale.status === "DRAFT" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Act saleId={sale.id} intent="start" label="Go live" primary disabled={busy} />
          <Act saleId={sale.id} intent="delete" label="Delete" disabled={busy} />
        </div>
      )}
      {sale.status === "ENDED" && (
        <div style={{ display: "grid", gap: 6 }}>
          {sale.lotIds.map((id, i) => {
            const l = byId.get(id);
            if (!l || time(l.startsAt) > now) return null;
            const sold = l.bidCount > 0 && (l.reservePrice == null || Number(l.currentBid) >= Number(l.reservePrice));
            return (
              <div key={id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <Thumb src={l.imageUrl} /> Lot {i + 1}: {l.title}, {sold ? `sold for ${money(l.currentBid)}` : "not sold"}
              </div>
            );
          })}
          <div><Act saleId={sale.id} intent="delete" label="Delete this sale" disabled={busy} /></div>
        </div>
      )}
    </div>
  );
}

export default function LiveSales() {
  const { allowed, shop, sales, lots, available } = useLoaderData();
  const result = useActionData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const now = useNow();
  const busy = navigation.state !== "idle";
  const anyLive = sales.some((s) => s.status === "LIVE");
  const byId = new Map(lots.map((l) => [l.id, l]));

  useEffect(() => {
    if (!anyLive) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine !== false && revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(t);
  }, [anyLive, revalidator]);

  return (
    <s-page heading="Live sales">
      {result?.error && (
        <div role="alert" style={{ ...card, borderColor: "#b3261e", color: "#b3261e", marginBottom: 12 }}>{result.error}</div>
      )}
      {result?.success && (
        <div role="status" style={{ ...card, borderColor: "#008060", color: "#005c45", marginBottom: 12 }}>{result.success}</div>
      )}

      {!allowed && (
        <s-section heading="Live Sale Mode">
          <s-stack gap="small">
            <s-text>
              Run a live auction night right on your store: line up your auctions, then sell them one at a time with a host console, a live room for your shoppers, and an optional embedded video stream. Bids, anti-sniping, winners and invoices all work exactly as usual.
            </s-text>
            <s-text>Live Sale Mode is part of the Inferno plan.</s-text>
            <s-link href="/app/plans">See plans</s-link>
          </s-stack>
        </s-section>
      )}

      {allowed && (
        <>
          <s-section heading="Your live sales">
            {sales.length === 0 ? (
              <s-text>You haven&rsquo;t created a live sale yet. Create one below.</s-text>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                {sales.map((s) => (
                  <SaleCard key={s.id} sale={s} byId={byId} shop={shop} busy={busy} now={now} />
                ))}
              </div>
            )}
          </s-section>

          <s-section heading="Create a live sale">
            {available.length === 0 ? (
              <s-text>
                First create the auctions you want to sell (on the Home page), starting at a time in the future, with no bids. They will appear here to choose from.
              </s-text>
            ) : (
              <Form method="post" style={{ display: "grid", gap: 14, maxWidth: 760 }}>
                <input type="hidden" name="intent" value="create" />
                <label style={{ display: "grid", gap: 4 }}>
                  <strong>Sale title</strong>
                  <input name="title" maxLength={80} placeholder="Friday frag night" required style={input} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <strong>Seconds per lot</strong>
                  <input name="lotSeconds" type="number" min={LOT_MIN} max={LOT_MAX} defaultValue={LOT_DEFAULT} style={{ ...input, maxWidth: 160 }} />
                  <span style={{ fontSize: 13, color: "#616161" }}>Between {LOT_MIN} and {LOT_MAX}. Each lot can still be extended while it runs.</span>
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <strong>Video link (optional)</strong>
                  <input name="videoUrl" placeholder="https://www.youtube.com/live/..." style={input} />
                  <span style={{ fontSize: 13, color: "#616161" }}>YouTube, Vimeo, Facebook or Twitch. It plays at the top of the live room.</span>
                </label>
                <fieldset style={{ border: "1px solid #d9d9d9", borderRadius: 8, padding: 12, display: "grid", gap: 8, margin: 0 }}>
                  <legend style={{ fontWeight: 700 }}>Choose the lots (they run in the order listed)</legend>
                  {available.map((a) => (
                    <label key={a.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <input type="checkbox" name="auctionId" value={a.id} />
                      <Thumb src={a.imageUrl} />
                      <span>
                        {a.title} <span style={{ color: "#616161", fontSize: 13 }}>(starts at {money(a.startingBid)})</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div><button type="submit" disabled={busy} style={btn(true)}>Create the sale</button></div>
              </Form>
            )}
          </s-section>
        </>
      )}
    </s-page>
  );
}
