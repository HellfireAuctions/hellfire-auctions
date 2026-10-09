import assert from "node:assert/strict";
import fs from "node:fs";

// A claim must never happen by accident: the first tap only asks, and only "Yes" claims, and only the item that was shown.
const room = fs.readFileSync("app/routes/api.proxy.live.jsx", "utf8");
assert.ok(room.includes("function askFirst()"), "the first tap asks");
assert.ok(room.includes("CLAIM \" + money(o.price), askFirst"), "the CLAIM button only asks");
assert.ok(!/money\(o\.price\), claim,/.test(room), "the CLAIM button never claims directly");
assert.ok(room.includes('"Yes, claim it"') && room.includes('"Cancel"'), "the question has Yes and Cancel");
assert.ok(room.includes("claim(o.id)"), "Yes claims the item that was shown, even if the host has moved on");
assert.ok(room.includes("setTimeout(cancelConfirm, 8000)"), "the question cancels itself");
assert.ok(room.includes("confirming && !(j.open && j.open.id === confirming)"), "and goes away if the item changes or closes");
assert.ok(room.includes('post("claim", { drop: id })'), "the claim sends the confirmed item");
console.log("Claim confirmation: all checks passed");
