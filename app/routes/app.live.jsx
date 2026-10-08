import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopPlan } from "../plans.server";
import { memoDelete } from "../memo.server";
import { publish } from "../live-hub.server";
import { embedFor } from "../video-embed";
import { parseNewItem, remaining } from "../action-sale";
import { photoProblem, squareCrop, outputSide } from "../photo-ratio";
import { addDropToSale, openDrop, closeOpenDrop, endShowAndInvoice } from "../action-sale.server";
import { createDropProduct, deleteDropProduct } from "../drop-product.server";

// Live Drops: the host's screen. The host streams anywhere (TikTok, Instagram, Facebook, YouTube...), shares the
// show's link, and sells items at a set price: press Go on an item and shoppers see a CLAIM button; the first people
// to tap get it. Everyone's claims are combined into one invoice.

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const plan = await getShopPlan(shop);
  const wanted = new URL(request.url).searchParams.get("sale");
  const sales = await prisma.actionSale.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, title: true, status: true } });
  const pick = wanted || (sales.find((s) => s.status === "LIVE") || sales.find((s) => s.status === "DRAFT") || sales[0])?.id || null;
  const sale = pick ? await prisma.actionSale.findFirst({ where: { id: pick, shop }, include: { drops: { orderBy: { position: "asc" } } } }) : null;
  const buyers = sale ? (await prisma.actionClaim.findMany({ where: { saleId: sale.id, shop }, select: { customerId: true }, distinct: ["customerId"] })).length : 0;
  return { allowed: plan.key === "INFERNO", shop, sales, buyers, sale: sale && { id: sale.id, title: sale.title, status: sale.status, videoUrl: sale.videoUrl, drops: sale.drops.map((d) => ({ id: d.id, title: d.title, imageUrl: d.imageUrl, price: d.price, quantity: d.quantity, claimed: d.claimed, perPerson: d.perPerson, status: d.status })) } };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  if ((await getShopPlan(shop)).key !== "INFERNO") return { error: "Live Drops is part of the Inferno plan." };
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const saleId = String(form.get("saleId") || "");
  const touch = (id) => {
    memoDelete("action:" + id); // shoppers see the change on their next refresh
    publish("sale-" + id, "update");
  };

  if (intent === "create-sale") {
    const title = String(form.get("title") || "").trim().slice(0, 80);
    if (!title) return { error: "Give the show a title." };
    const videoUrl = String(form.get("videoUrl") || "").trim();
    if (videoUrl && !embedFor(videoUrl)) return { error: "That video link can't be shown on the page. YouTube, Vimeo, Facebook and Twitch links work. For TikTok or Instagram, leave this empty and share the show's link while you stream." };
    const created = await prisma.actionSale.create({ data: { shop, title, videoUrl: videoUrl || null } });
    return redirect(`/app/live?sale=${created.id}`);
  }

  const sale = await prisma.actionSale.findFirst({ where: { id: saleId, shop } });
  if (!sale) return { error: "That show wasn't found." };

  if (intent === "add-drop") {
    const parsed = parseNewItem(form);
    if (!parsed.ok) return { error: parsed.error };
    if (sale.status === "ENDED") return { error: "This show has ended." };
    const photo = form.get("photo");
    const hasPhoto = Boolean(photo) && typeof photo === "object" && photo.size > 0;
    if (hasPhoto) {
      if (!photo.type?.startsWith("image/")) return { error: "The photo must be an image file." };
      const problem = await photoProblem([photo]); // always square, like every photo in the app
      if (problem) return { error: problem };
    }
    let made;
    try {
      // The app creates the product itself (hidden from the shop's catalog), so Live Drops needs nothing set up beforehand.
      made = await createDropProduct({ admin, title: parsed.item.title, price: parsed.item.price, imageFile: hasPhoto ? photo : null });
    } catch (error) {
      console.error("[HELLFIRE LIVE DROPS] could not create the product:", error?.message || error);
      return { error: "Shopify couldn't create the product just now. Please try again." };
    }
    const added = await addDropToSale({ shop, saleId, drop: { ...parsed.item, productId: made.productId, variantId: made.variantId, imageUrl: made.imageUrl } });
    if (!added.ok) {
      await deleteDropProduct(admin, made.productId);
      return { error: added.message };
    }
    touch(saleId);
    return { success: "Item added. Press Go when you're ready to sell it." };
  }
  if (intent === "remove-drop") {
    const drop = await prisma.actionDrop.findFirst({ where: { id: String(form.get("dropId") || ""), saleId, shop } });
    if (!drop) return { error: "That item wasn't found." };
    if (drop.status === "OPEN" || drop.claimed > 0) return { error: "An item that is open, or already has claims, can't be removed." };
    await prisma.actionDrop.delete({ where: { id: drop.id } });
    await deleteDropProduct(admin, drop.productId); // the hidden product it made goes too
    touch(saleId);
    return { success: "Item removed." };
  }
  if (intent === "start") {
    if (sale.status !== "DRAFT") return { error: "This show has already started." };
    if (!(await prisma.actionDrop.count({ where: { saleId } }))) return { error: "Add at least one item first." };
    await prisma.actionSale.update({ where: { id: saleId }, data: { status: "LIVE" } });
    touch(saleId);
    return { success: "The show is live. Press Go on an item when you're ready to sell it." };
  }
  if (intent === "go") {
    const opened = await openDrop({ shop, saleId, dropId: String(form.get("dropId") || "") });
    if (!opened.ok) return { error: opened.message };
    touch(saleId);
    return { success: "Open: shoppers can claim it now." };
  }
  if (intent === "close") {
    const closed = await closeOpenDrop({ shop, saleId });
    if (!closed.ok) return { error: closed.message };
    touch(saleId);
    return { success: "Closed." };
  }
  if (intent === "end" || intent === "invoices") {
    if (intent === "invoices" && sale.status !== "ENDED") return { error: "End the show first." };
    const result = await endShowAndInvoice({ shop, saleId, admin });
    touch(saleId);
    if (!result.ok) return { error: result.message };
    return { success: `${intent === "end" ? "The show has ended. " : ""}${result.people} shopper${result.people === 1 ? "" : "s"} claimed items. ${result.sent} invoice${result.sent === 1 ? "" : "s"} sent${result.failed ? `, ${result.failed} failed (check your store's sender email)` : ""}${result.pending ? `, ${result.pending} still to send: press "Send invoices" again` : ""}.` };
  }
  if (intent === "delete-sale") {
    if (sale.status === "LIVE") return { error: "End the show before deleting it." };
    const unclaimed = await prisma.actionDrop.findMany({ where: { saleId, shop, claimed: 0 }, select: { productId: true } });
    for (const d of unclaimed) await deleteDropProduct(admin, d.productId); // products with claims stay: invoices refer to them
    await prisma.actionSale.delete({ where: { id: saleId } });
    return redirect("/app/live");
  }
  return { error: "Unknown action." };
};

const card = { border: "1px solid #d9d9d9", borderRadius: 12, padding: 16, background: "#fff", display: "grid", gap: 12 };
const field = { padding: "9px 12px", border: "1px solid #8a8a8a", borderRadius: 8, font: "inherit", width: "100%", boxSizing: "border-box" };
const button = (primary) => ({ padding: "10px 16px", borderRadius: 8, border: primary ? "none" : "1px solid #8a8a8a", background: primary ? "#303030" : "#f6f6f7", color: primary ? "#fff" : "#303030", fontWeight: 600, cursor: "pointer", font: "inherit" });
const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const STATUS = { DRAFT: ["NOT STARTED", "#616161"], LIVE: ["\u25CF LIVE", "#b3261e"], ENDED: ["ENDED", "#616161"], QUEUED: ["WAITING", "#616161"], OPEN: ["\u25CF OPEN", "#008060"], CLOSED: ["CLOSED", "#616161"] };

function Thumb({ src }) {
  return src ? <img src={src} alt="" style={{ width: 52, height: 52, objectFit: "cover", aspectRatio: "1 / 1", borderRadius: 8, flex: "none" }} /> : <div style={{ width: 52, height: 52, borderRadius: 8, background: "#e3e3e3", flex: "none" }} />;
}

function Act({ saleId, intent, label, primary, disabled, extra }) {
  return (
    <Form method="post" style={{ display: "inline-block" }}>
      <input type="hidden" name="saleId" value={saleId} />
      <input type="hidden" name="intent" value={intent} />
      {extra}
      <button type="submit" disabled={disabled} style={{ ...button(primary), opacity: disabled ? 0.5 : 1 }}>{label}</button>
    </Form>
  );
}

// Crops a chosen photo to a centred square on the device before it is uploaded (JPEG, 1600 px at most).
async function squarePhoto(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const { sx, sy, side } = squareCrop(bitmap.width, bitmap.height);
    const out = outputSide(side);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out, out);
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, out, out);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    return blob ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }) : null;
  } catch {
    return null;
  }
}

// Adding an item is one quick form: the app creates the product itself, so it works the moment you are live.
function AddItem({ saleId, busy }) {
  const result = useActionData();
  const formRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (result?.success && String(result.success).startsWith("Item added")) {
      formRef.current?.reset();
      setPreview(null);
    }
  }, [result]);
  async function onPhoto(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) {
      setPreview(null);
      return;
    }
    const squared = await squarePhoto(file);
    if (!squared) {
      setNote("We couldn't read that photo. Please use a JPG, PNG, WebP or GIF image.");
      input.value = "";
      setPreview(null);
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(squared);
    input.files = transfer.files;
    setNote("");
    setPreview(URL.createObjectURL(squared));
  }
  return (
    <Form ref={formRef} method="post" encType="multipart/form-data" style={{ display: "grid", gap: 10 }}>
      <input type="hidden" name="intent" value="add-drop" />
      <input type="hidden" name="saleId" value={saleId} />
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ ...button(false), display: "inline-block" }}>
          Add a photo
          <input name="photo" type="file" accept="image/*" onChange={onPhoto} style={{ display: "none" }} />
        </label>
        {preview ? <Thumb src={preview} /> : <span style={{ fontSize: 13, color: "#616161" }}>Optional, but shoppers like to see the item. It is cropped to a square for you.</span>}
      </div>
      {note && <div role="alert" style={{ color: "#b3261e" }}>{note}</div>}
      <label>What is it?<input name="title" maxLength={120} placeholder="Rainbow zoanthid frag" required style={field} /></label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10 }}>
        <label>Price<input name="price" type="number" step="0.01" min="0.01" required style={field} /></label>
        <label>How many<input name="quantity" type="number" min="1" defaultValue="1" required style={field} /></label>
        <label>Limit per person<input name="perPerson" type="number" min="1" defaultValue="1" style={field} /></label>
      </div>
      <div><button type="submit" disabled={busy} style={{ ...button(true), opacity: busy ? 0.5 : 1 }}>{busy ? "Adding..." : "Add to the show"}</button></div>
    </Form>
  );
}

export default function LiveActionSale() {
  const { allowed, shop, sales, sale, buyers } = useLoaderData();
  const result = useActionData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle";
  const live = sale?.status === "LIVE";

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine !== false && revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [live, revalidator]);

  const link = sale ? `https://${shop}/apps/hellfire-auctions/live?sale=${sale.id}` : "";
  const chip = (key) => <span style={{ color: STATUS[key][1], fontWeight: 700, fontSize: 12 }}>{STATUS[key][0]}</span>;

  return (
    <s-page heading="Live Drops">
      {result?.error && <div role="alert" style={{ ...card, borderColor: "#b3261e", color: "#b3261e", marginBottom: 12 }}>{result.error}</div>}
      {result?.success && <div role="status" style={{ ...card, borderColor: "#008060", color: "#005c45", marginBottom: 12 }}>{result.success}</div>}

      {!allowed ? (
        <s-section heading="Sell live, at set prices">
          <s-stack gap="small">
            <s-text>Show items on video (TikTok, Instagram, Facebook, YouTube, anywhere), say a price, and shoppers tap CLAIM. The first people to tap get it, and each shopper gets one combined invoice.</s-text>
            <s-text>Live Drops is part of the Inferno plan.</s-text>
            <s-link href="/app/plans">See plans</s-link>
          </s-stack>
        </s-section>
      ) : (
        <>
          <s-section heading="Your shows">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {sales.map((s) => (
                <Link key={s.id} to={`/app/live?sale=${s.id}`} style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid #8a8a8a", textDecoration: "none", background: sale?.id === s.id ? "#303030" : "#fff", color: sale?.id === s.id ? "#fff" : "#303030", fontWeight: 600 }}>{s.title}</Link>
              ))}
              {sales.length === 0 && <span>No shows yet.</span>}
            </div>
            <Form method="post" style={{ display: "grid", gap: 10, maxWidth: 640 }}>
              <input type="hidden" name="intent" value="create-sale" />
              <label>New show title<input name="title" maxLength={80} placeholder="Friday frag night" required style={field} /></label>
              <label>Video link (optional)<input name="videoUrl" placeholder="YouTube, Vimeo, Facebook or Twitch" style={field} /></label>
              <div style={{ fontSize: 13, color: "#616161" }}>Streaming on TikTok or Instagram? Leave the video link empty and share the show&rsquo;s link while you stream.</div>
              <div><button type="submit" disabled={busy} style={button(true)}>Create the show</button></div>
            </Form>
          </s-section>

          {sale && (
            <s-section heading={sale.title}>
              <div style={{ display: "grid", gap: 14 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  {chip(sale.status)}
                  <span style={{ fontSize: 13 }}>{buyers} shopper{buyers === 1 ? "" : "s"} with claims</span>
                  {sale.status === "DRAFT" && <Act saleId={sale.id} intent="start" label="Start the show" primary disabled={busy || sale.drops.length === 0} />}
                  {live && <Act saleId={sale.id} intent="end" label="End the show and send invoices" disabled={busy} />}
                  {sale.status === "ENDED" && <Act saleId={sale.id} intent="invoices" label="Send invoices" primary disabled={busy} />}
                  {sale.status !== "LIVE" && <Act saleId={sale.id} intent="delete-sale" label="Delete" disabled={busy} />}
                </div>
                <div style={{ fontSize: 13, wordBreak: "break-all" }}>Share this link with your viewers: <a href={link} target="_blank" rel="noreferrer">{link}</a></div>

                {sale.status !== "ENDED" && (
                  <div style={card}>
                    <strong>Add an item</strong>
                    <AddItem saleId={sale.id} busy={busy} />
                  </div>
                )}

                <div style={{ display: "grid", gap: 8 }}>
                  {sale.drops.length === 0 && <span>No items yet. Add your first item above.</span>}
                  {sale.drops.map((d) => (
                    <div key={d.id} style={{ ...card, padding: 12, borderColor: d.status === "OPEN" ? "#008060" : "#d9d9d9", borderWidth: d.status === "OPEN" ? 2 : 1 }}>
                      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <Thumb src={d.imageUrl} />
                        <div style={{ flex: 1, minWidth: 180 }}>
                          <div style={{ fontWeight: 600 }}>{d.title} {chip(d.status)}</div>
                          <div style={{ fontSize: 14 }}>{money(d.price)} · {d.claimed} of {d.quantity} claimed · {remaining(d)} left{d.perPerson > 1 ? ` · limit ${d.perPerson} each` : ""}</div>
                        </div>
                        {live && d.status !== "OPEN" && remaining(d) > 0 && <Act saleId={sale.id} intent="go" label="Go" primary disabled={busy} extra={<input type="hidden" name="dropId" value={d.id} />} />}
                        {live && d.status === "OPEN" && <Act saleId={sale.id} intent="close" label="Close" disabled={busy} />}
                        {sale.status !== "ENDED" && d.status !== "OPEN" && d.claimed === 0 && <Act saleId={sale.id} intent="remove-drop" label="Remove" disabled={busy} extra={<input type="hidden" name="dropId" value={d.id} />} />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </s-section>
          )}
        </>
      )}
    </s-page>
  );
}
