import assert from "node:assert/strict";
import { embedFor } from "../app/video-embed.js";

// ---------- video links ----------
assert.deepEqual(embedFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { kind: "youtube", src: "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&rel=0" });
assert.equal(embedFor("https://youtu.be/dQw4w9WgXcQ?t=5").kind, "youtube");
assert.equal(embedFor("https://m.youtube.com/live/dQw4w9WgXcQ").src.includes("/embed/dQw4w9WgXcQ"), true);
assert.equal(embedFor("https://www.youtube.com/embed/dQw4w9WgXcQ").kind, "youtube");
assert.equal(embedFor("https://vimeo.com/123456789").src, "https://player.vimeo.com/video/123456789?autoplay=1&muted=1");
assert.equal(embedFor("https://www.facebook.com/hellfirefrags/videos/123456789/").kind, "facebook");
assert.ok(embedFor("https://fb.watch/abc123/").src.startsWith("https://www.facebook.com/plugins/video.php?href="));
assert.equal(embedFor("https://www.twitch.tv/HellfireFrags").src, "https://player.twitch.tv/?channel=hellfirefrags&parent={parent}&muted=true");
for (const bad of ["", null, undefined, "not a link", "http://youtu.be/dQw4w9WgXcQ", "https://evil.example/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=<script>", "https://www.youtube.com/watch", "javascript:alert(1)", "https://vimeo.com/abc", "https://www.twitch.tv/", "https://www.twitch.tv/a b", "https://www.youtube.com/watch?v=" + "x".repeat(40)]) {
  assert.equal(embedFor(bad), null, String(bad));
}

console.log("Video links: all checks passed");
