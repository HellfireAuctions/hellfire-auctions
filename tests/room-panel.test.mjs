import assert from "node:assert/strict";
import fs from "node:fs";

// The live room only works if (1) the room loads the bidding panel code itself and (2) the panel never sends a shopper
// away from the room. These are checks on the source, so neither can be removed by accident.
const room = fs.readFileSync("app/routes/api.proxy.live.jsx", "utf8");
assert.ok(room.includes('getElementById("hellfire-auction-runtime")'), "the room finds the embed's element");
assert.ok(room.includes('getAttribute("data-experience-src")'), "...reads the panel's address from it");
assert.ok(room.includes('setAttribute("data-hellfire-auction-experience"'), "...and loads the panel, marked the way the page script marks it (so it is never loaded twice)");
assert.ok(room.includes("!window.__hellfireAuctionRemount"), "...unless the panel is already there");
assert.ok(/Bidding is not available on this page yet/.test(room), "...and says so plainly when the embed is off");
assert.ok(room.includes('id="hellfire-auction-root"'), "the container the panel mounts into is still on the page");

const panel = fs.readFileSync("extensions/hellfire-auctions-storefront/assets/auction.js", "utf8");
const guard = panel.indexOf('location.pathname.indexOf("/apps/hellfire-auctions/live")===0');
const redirect = panel.indexOf('location.replace(((window.Shopify&&Shopify.routes&&Shopify.routes.root)||"/")+"collections/live-auctions")');
assert.ok(guard > 0 && redirect > 0, "both the guard and the redirect exist");
assert.ok(guard < redirect, "the guard comes before the redirect, so it can stop it");

// the embed publishes the panel's address on every page (not only product pages), which the room depends on
const liquid = fs.readFileSync("extensions/hellfire-auctions-storefront/blocks/auction-runtime.liquid", "utf8");
assert.ok(/data-experience-src="\{\{ 'auction\.js' \| asset_url \}\}"/.test(liquid), "the embed always publishes the panel address");

console.log("Live room bidding panel: all checks passed");
