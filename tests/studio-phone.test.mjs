import assert from "node:assert/strict";
import fs from "node:fs";
const s = fs.readFileSync("app/routes/live-studio.jsx", "utf8").replace(/\r\n/g, "\n");
assert.ok(s.includes('navigator.wakeLock.request("screen")'), "the Studio asks the phone to keep the screen on while live");
assert.ok(s.includes("navigator.wakeLock && document.visibilityState"), "only where the phone supports it, and only while visible");
assert.ok(s.includes('document.addEventListener("visibilitychange", back)') && s.includes('document.removeEventListener("visibilitychange", back)'), "it watches for the host coming back to the page, and tidies up");
assert.ok(s.includes('video.readyState === "ended") await openCamera(facing)'), "a paused camera is turned back on when the host returns");
assert.ok(s.includes("lock?.release?.()"), "the screen lock is released when the show ends");
const effect = s.slice(s.indexOf("if (!live) return undefined;\n    let lock = null;"), s.indexOf("}, [live, facing]);"));
assert.ok(effect.length > 200 && !effect.includes("pcRef.current?.close()") && !effect.includes('call("stop")'), "recovering the camera never stops the show");
assert.ok(s.includes("Keep this page open and your phone's screen on while you're live."), "the host is told to keep the page open");
assert.ok(s.indexOf("setLive(true);\n      setNotice(") > 0, "and told at the moment they go live");
// the camera swap it relies on keeps the connection: it replaces the tracks on the live senders
assert.ok(s.includes("await sender.replaceTrack(track)"), "replacing the camera keeps the same connection");
console.log("Studio phone protection: all checks passed");
