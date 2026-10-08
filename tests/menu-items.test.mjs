import assert from "node:assert/strict";
import { menuStatus, itemsToAdd, isLiveAuctionsItem, LIVE_PATH, MY_AUCTIONS_PATH } from "../app/menu-items.js";

const item = (title, url, items = []) => ({ id: "x", title, url, items });

// ---------- what the menu already has ----------
assert.deepEqual(menuStatus([item("Home", "/"), item("Catalog", "/collections/all")]), { hasLive: false, hasMyAuctions: false }, "a new store's menu has neither");
assert.deepEqual(menuStatus([item("My Auctions", MY_AUCTIONS_PATH)]), { hasLive: false, hasMyAuctions: true }, "only My Auctions: exactly the screenshot");
assert.deepEqual(menuStatus([item("Live Auctions", "https://shop.example.com/collections/live-auctions")]), { hasLive: true, hasMyAuctions: false }, "a collection link has the full address");
assert.equal(menuStatus([item("Auctions now", LIVE_PATH)]).hasLive, true, "recognised by its address, whatever it is called");
assert.equal(menuStatus([item("  live AUCTIONS ", "https://x.com/pages/whatever")]).hasLive, true, "recognised by its name, in any capitals");
assert.equal(menuStatus([item("Shop", "/collections/all", [item("Live Auctions", LIVE_PATH)])]).hasLive, true, "inside a submenu");
assert.equal(menuStatus([item("A", "/", [item("B", "/", [item("My Auctions", MY_AUCTIONS_PATH)])])]).hasMyAuctions, true, "two levels down");
assert.deepEqual(menuStatus([item("Live Auctions", LIVE_PATH), item("My Auctions", MY_AUCTIONS_PATH)]), { hasLive: true, hasMyAuctions: true });
for (const odd of [null, undefined, [], [null], [{}], "x"]) assert.deepEqual(menuStatus(odd), { hasLive: false, hasMyAuctions: false }, JSON.stringify(odd));
assert.equal(isLiveAuctionsItem(item("Live auction tips", "/pages/tips")), false, "a similar name is not the same thing");
assert.equal(isLiveAuctionsItem(item("Past live auctions", "/collections/past-live-auctions")), false, "a different collection");

// ---------- what gets added ----------
const COL = "gid://shopify/Collection/123";
assert.deepEqual(itemsToAdd({ hasLive: false, hasMyAuctions: false, collectionId: COL }), [
  { title: "Live Auctions", type: "COLLECTION", resourceId: COL, items: [] },
  { title: "My Auctions", type: "HTTP", url: MY_AUCTIONS_PATH, items: [] },
], "both, Live Auctions first, pointing at the collection itself");
assert.deepEqual(itemsToAdd({ hasLive: false, hasMyAuctions: false, collectionId: null }), [
  { title: "Live Auctions", type: "HTTP", url: LIVE_PATH, items: [] },
  { title: "My Auctions", type: "HTTP", url: MY_AUCTIONS_PATH, items: [] },
], "if the collection couldn't be prepared, the standard address is used");
assert.deepEqual(itemsToAdd({ hasLive: false, hasMyAuctions: true, collectionId: COL }), [{ title: "Live Auctions", type: "COLLECTION", resourceId: COL, items: [] }], "adds only what is missing (the screenshot's store)");
assert.deepEqual(itemsToAdd({ hasLive: true, hasMyAuctions: false }), [{ title: "My Auctions", type: "HTTP", url: MY_AUCTIONS_PATH, items: [] }]);
assert.deepEqual(itemsToAdd({ hasLive: true, hasMyAuctions: true, collectionId: COL }), [], "nothing to add: nothing is duplicated");
assert.deepEqual(itemsToAdd({ hasLive: true, hasMyAuctions: false, myAuctionsUrl: "/custom/path" })[0].url, "/custom/path", "a custom address is respected");

// ---------- running it twice never duplicates ----------
const menu = [item("Home", "/"), item("Catalog", "/collections/all")];
const added = itemsToAdd({ ...menuStatus(menu), collectionId: COL });
const menuAfter = [...menu, ...added.map((i) => ({ ...i, url: i.url || "https://shop.example.com/collections/live-auctions" }))];
assert.deepEqual(itemsToAdd({ ...menuStatus(menuAfter), collectionId: COL }), [], "the second click adds nothing");

console.log("Menu links: all checks passed");
