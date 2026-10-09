import assert from "node:assert/strict";
import fs from "node:fs";

// Cloudflare sends the picture and the sound as two separate streams. The room's player must collect every incoming
// track into one stream; attaching "the stream of the last track" showed sound with a black picture.
const room = fs.readFileSync("app/routes/api.proxy.live.jsx", "utf8");
assert.ok(room.includes("var bag = new MediaStream();"), "the player makes one stream to collect tracks in");
assert.ok(room.includes("bag.addTrack(e.track);"), "every incoming track (picture and sound) goes into it");
assert.ok(room.includes("live.video.srcObject = bag"), "and the video element plays that one stream");
assert.ok(!room.includes("srcObject = e.streams[0]"), "never just one of the incoming streams");
assert.ok(room.includes("max-width:640px") && room.includes("min-height:min(600px,100vw)"), "the player is large");
assert.ok(room.includes("requestFullscreen") && room.includes("webkitEnterFullscreen"), "there is a Full screen button, including on iPhones");
assert.ok(room.includes("v.muted = false"), "and a way to turn the sound on");
console.log("Room video player: all checks passed");
