// A pasted video link becomes a safe player address, or null. Used for the optional video on a Live Drops page.
// Only YouTube, Vimeo, Facebook and Twitch links are accepted, and only over https.
// The Twitch player must be told which site it sits on, so its address holds {parent} for the page to fill in.
export function embedFor(videoUrl) {
  let url;
  try {
    url = new URL(String(videoUrl || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\.|^m\./, "").toLowerCase();
  const idOk = (id) => typeof id === "string" && /^[\w-]{6,20}$/.test(id);

  if (host === "youtube.com" || host === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = host === "youtu.be" ? parts[0] : url.searchParams.get("v") || (["live", "embed", "shorts"].includes(parts[0]) ? parts[1] : null);
    return idOk(id) ? { kind: "youtube", src: `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&rel=0` } : null;
  }
  if (host === "vimeo.com") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return /^\d{5,12}$/.test(id || "") ? { kind: "vimeo", src: `https://player.vimeo.com/video/${id}?autoplay=1&muted=1` } : null;
  }
  if (host === "facebook.com" || host === "fb.watch") {
    return { kind: "facebook", src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url.toString())}&show_text=false&autoplay=true&mute=true` };
  }
  if (host === "twitch.tv") {
    const channel = url.pathname.split("/").filter(Boolean)[0];
    return /^\w{3,25}$/.test(channel || "") ? { kind: "twitch", src: `https://player.twitch.tv/?channel=${channel.toLowerCase()}&parent={parent}&muted=true` } : null;
  }
  return null;
}
