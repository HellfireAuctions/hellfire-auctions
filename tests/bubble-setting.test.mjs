import assert from "node:assert/strict";
import { wantsBubble, bubbleOn } from "../app/bubble-setting.js";

// ---------- what the form sends ----------
assert.equal(wantsBubble(["off", "on"]), true, "ticked: the hidden off plus on");
assert.equal(wantsBubble(["off"]), false, "unticked: only the hidden off");
assert.equal(wantsBubble(["on"]), true);
assert.equal(wantsBubble([]), false);
assert.equal(wantsBubble(undefined), false);
assert.equal(wantsBubble(null), false);
assert.equal(wantsBubble("on"), false, "a plain string is not what a form sends");
assert.equal(wantsBubble(["ON"]), false, "only the exact value counts");
assert.equal(wantsBubble(["yes", "true", "1"]), false);

// ---------- what is stored ----------
assert.equal(bubbleOn(null), true, "a store with no settings yet");
assert.equal(bubbleOn(undefined), true);
assert.equal(bubbleOn({}), true, "a settings row from before this option existed");
assert.equal(bubbleOn({ showLiveBubble: null }), true);
assert.equal(bubbleOn({ showLiveBubble: true }), true);
assert.equal(bubbleOn({ showLiveBubble: false }), false, "only an explicit off turns it off");

console.log("Live Auctions button switch: all checks passed");
