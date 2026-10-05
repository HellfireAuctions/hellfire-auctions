import assert from "node:assert/strict";
import { isNetworkError } from "../app/network-error.js";

// the exact error from the screenshot, and the wording other browsers use for the same thing
assert.equal(isNetworkError(new TypeError("Failed to fetch")), true, "Chrome / Edge");
assert.equal(isNetworkError(new TypeError("NetworkError when attempting to fetch resource.")), true, "Firefox");
assert.equal(isNetworkError(new TypeError("Load failed")), true, "Safari");
assert.equal(isNetworkError(new TypeError("Network request failed")), true);
assert.equal(isNetworkError(new Error("fetch failed")), true, "Node-style");
assert.equal(isNetworkError(new TypeError("The Internet connection appears to be offline.")), true);

// real answers from the server are not "the connection dropped"
assert.equal(isNetworkError({ status: 500, statusText: "Server Error", data: "boom" }), false, "a response with a status");
assert.equal(isNetworkError({ status: 404, data: "Not found" }), false);
assert.equal(isNetworkError({ data: "Failed to fetch" }), false, "a thrown response, even with that text");
assert.equal(isNetworkError(new Error("Cannot read properties of undefined")), false, "a bug is a bug");
assert.equal(isNetworkError(new TypeError("x is not a function")), false);
assert.equal(isNetworkError(new Error("")), false);

// nothing to inspect
assert.equal(isNetworkError(null), false);
assert.equal(isNetworkError(undefined), false);
assert.equal(isNetworkError("Failed to fetch"), false, "only real error objects");
assert.equal(isNetworkError({}), false);

console.log("Dropped-connection detection: all checks passed");
