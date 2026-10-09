import { useCallback, useEffect, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { verifyStudioToken } from "../studio-token.server";
import { goLiveEnabled } from "../go-live";
import { streamConfigured } from "../cloudflare-stream.server";

// The Live Studio: the host's camera, a Go live button, and the item controls, in one browser tab. It opens from the
// app in its own tab because cameras can't run inside Shopify's admin frame. The signed link in the address is its key.

export const meta = () => [{ title: "Live Studio" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }) => {
  const token = new URL(request.url).searchParams.get("t") || "";
  const verdict = verifyStudioToken(token, process.env.SHOPIFY_API_SECRET);
  if (!verdict.ok) return { state: "expired" };
  if (!goLiveEnabled(verdict.shop, process.env.GOLIVE_SHOPS) || !streamConfigured()) return { state: "off" };
  return { state: "ok", token };
};

const page = { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", maxWidth: 760, margin: "0 auto", padding: "16px 14px 60px", color: "#202223" };
const btn = (primary, danger) => ({ padding: "12px 18px", borderRadius: 10, border: primary || danger ? "none" : "1px solid #8a8a8a", background: danger ? "#d72c0d" : primary ? "#202223" : "#f6f6f7", color: primary || danger ? "#fff" : "#202223", fontWeight: 700, fontSize: 16, cursor: "pointer" });
const card = { border: "1px solid #d9d9d9", borderRadius: 12, padding: 14, margin: "12px 0", background: "#fff" };
const money = (v) => `$${Number(v || 0).toFixed(2)}`;

function waitForIce(pc, ms = 2500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, ms);
  });
}

// WHIP: send the camera to the video service and get its answer.
async function publishTo(pc, url) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIce(pc);
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription.sdp });
  if (!response.ok) throw new Error(`The video service refused the stream (${response.status}).`);
  await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
}

function Studio({ token }) {
  const [show, setShow] = useState(null);
  const [camera, setCamera] = useState("off");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [facing, setFacing] = useState("user");
  const [muted, setMuted] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const pcRef = useRef(null);
  const beatRef = useRef(null);

  const call = useCallback(async (intent, extra = {}) => {
    const body = new URLSearchParams({ t: token, intent, ...extra });
    const response = await fetch("/api/studio", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    return response.json().catch(() => ({ ok: false, message: "No answer from the server." }));
  }, [token]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/studio?t=${encodeURIComponent(token)}`, { cache: "no-store" });
      const json = await response.json();
      if (json.ok) setShow(json);
      else setMessage(json.message || "");
    } catch {
      /* the next check will try again */
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => () => {
    clearInterval(beatRef.current);
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    if (!live) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);

  async function openCamera(nextFacing = facing) {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextFacing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      stream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCamera("on");
      setMessage("");
      if (pcRef.current) {
        // already live: switch the picture without stopping the show
        for (const sender of pcRef.current.getSenders()) {
          const track = stream.getTracks().find((t) => t.kind === sender.track?.kind);
          if (track) await sender.replaceTrack(track);
        }
      }
      return true;
    } catch {
      setCamera("error");
      setMessage("The camera or microphone could not be turned on. Allow access in your browser (the camera icon near the address), then try again.");
      return false;
    }
  }

  async function flip() {
    const next = facing === "user" ? "environment" : "user";
    setFacing(next);
    await openCamera(next);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    streamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next; });
  }

  async function goLive() {
    setBusy(true);
    setMessage("");
    try {
      if (!streamRef.current && !(await openCamera())) return;
      const started = await call("start");
      if (!started.ok) {
        setMessage(started.message || "Could not start the video.");
        return;
      }
      pcRef.current?.close();
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
      pcRef.current = pc;
      streamRef.current.getTracks().forEach((track) => pc.addTransceiver(track, { direction: "sendonly" }));
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          if (pcRef.current === pc) {
            clearInterval(beatRef.current);
            setLive(false);
            setMessage("The video connection was lost. Press Go live to start again.");
          }
        }
      };
      await publishTo(pc, started.publishUrl);
      setLive(true);
      clearInterval(beatRef.current);
      beatRef.current = setInterval(() => call("beat"), 5000);
    } catch (error) {
      setMessage(error?.message || "Could not start the video. Please try again.");
      pcRef.current?.close();
      pcRef.current = null;
      setLive(false);
    } finally {
      setBusy(false);
    }
  }

  async function stopLive() {
    setBusy(true);
    clearInterval(beatRef.current);
    pcRef.current?.close();
    pcRef.current = null;
    setLive(false);
    await call("stop");
    setBusy(false);
  }

  async function control(intent, extra) {
    setBusy(true);
    const result = await call(intent, extra);
    setMessage(result.ok ? result.message || "" : result.message || "That did not work.");
    await refresh();
    setBusy(false);
  }

  const open = show?.drops.find((d) => d.status === "OPEN");
  const ended = show?.status === "ENDED";
  return (
    <div style={page}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{show ? show.title : "Live Studio"}</h1>
        <span style={{ fontWeight: 800, color: live ? "#d72c0d" : "#616161" }}>{live ? "\u25CF YOU ARE LIVE" : "Not streaming"}</span>
      </div>
      <div style={{ position: "relative", background: "#000", borderRadius: 12, overflow: "hidden", aspectRatio: "16 / 9", marginTop: 12 }}>
        <video ref={videoRef} autoPlay playsInline muted data-testid="preview" style={{ width: "100%", height: "100%", objectFit: "cover", transform: facing === "user" ? "scaleX(-1)" : "none" }} />
        {camera !== "on" && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", padding: 16, textAlign: "center" }}>Your camera is off</div>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        {camera !== "on" && <button type="button" style={btn(true)} onClick={() => openCamera()}>Turn on camera</button>}
        {!live && !ended && <button type="button" id="go-live" style={btn(false, true)} disabled={busy} onClick={goLive}>Go live</button>}
        {live && <button type="button" id="stop-live" style={btn(true)} disabled={busy} onClick={stopLive}>Stop streaming</button>}
        {camera === "on" && <button type="button" style={btn(false)} onClick={flip}>Flip camera</button>}
        {camera === "on" && <button type="button" style={btn(false)} onClick={toggleMute}>{muted ? "Unmute" : "Mute"}</button>}
      </div>
      {message && <div role="status" style={{ ...card, borderColor: "#b3261e", color: "#8e1f0b" }}>{message}</div>}
      {show && (
        <>
          <div style={{ fontSize: 14 }}>{show.buyers} shopper{show.buyers === 1 ? "" : "s"} with claims</div>
          {show.room && <div style={{ fontSize: 13, wordBreak: "break-all", margin: "4px 0" }}>Shoppers watch and claim here: <a href={show.room} target="_blank" rel="noreferrer">{show.room}</a></div>}
          <div style={{ ...card, borderColor: open ? "#008060" : "#d9d9d9", borderWidth: 2 }}>
            <strong>Now selling</strong>
            {open ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{open.title}</div>
                <div>{money(open.price)} {"\u00B7"} {open.claimed} of {open.quantity} claimed</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  <button type="button" style={btn(false)} disabled={busy} onClick={() => control("close")}>Close this item</button>
                  <button type="button" style={btn(true)} disabled={busy} onClick={() => control("next")}>Close and open the next item</button>
                </div>
              </>
            ) : (
              <>
                <div>No item is open.</div>
                {!ended && <div style={{ marginTop: 8 }}><button type="button" style={btn(true)} disabled={busy || show.status !== "LIVE"} onClick={() => control("next")}>Open the next item</button></div>}
                {show.status === "DRAFT" && <div style={{ fontSize: 13, marginTop: 6 }}>Start the show in the app first (Live Drops, Start the show).</div>}
              </>
            )}
          </div>
          {show.drops.map((d) => (
            <div key={d.id} style={{ ...card, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: 10 }}>
              {d.imageUrl && <img src={d.imageUrl} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8 }} />}
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontWeight: 600 }}>{d.title}</div>
                <div style={{ fontSize: 13 }}>{money(d.price)} {"\u00B7"} {d.claimed} of {d.quantity} claimed {"\u00B7"} {d.status === "OPEN" ? "OPEN" : d.status === "CLOSED" ? "closed" : "waiting"}</div>
              </div>
              {show.status === "LIVE" && d.status !== "OPEN" && d.claimed < d.quantity && <button type="button" style={btn(false)} disabled={busy} onClick={() => control("go", { dropId: d.id })}>Open for claiming</button>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default function LiveStudio() {
  const data = useLoaderData();
  if (data.state === "expired") {
    return <div style={page}><h1>This Studio link has expired</h1><p>Open Live Drops in your Shopify app and press <strong>Open Live Studio</strong> again.</p></div>;
  }
  if (data.state === "off") {
    return <div style={page}><h1>Go Live isn&rsquo;t switched on</h1><p>Built-in video is a beta add-on and isn&rsquo;t available for this store yet.</p></div>;
  }
  return <Studio token={data.token} />;
}
