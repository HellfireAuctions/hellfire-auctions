import assert from "node:assert/strict";
import fs from "node:fs";

// The live app uses Neon. The setup file must not tie anything to the retired Render database, and the app must say so loudly
// if the Neon setting is ever lost.
const yaml = fs.readFileSync("render.yaml", "utf8");
assert.ok(!yaml.includes("fromDatabase"), "nothing is linked to a Render database");
assert.ok(!yaml.includes("hellfire-auctions-db"), "the retired database is not mentioned as a resource");
assert.ok(!/^databases:/m.test(yaml), "there is no databases section");
assert.ok(yaml.includes("key: NEON_DATABASE_URL"), "the Neon setting is documented");

const db = fs.readFileSync("app/db.server.js", "utf8");
assert.ok(db.includes("process.env.NEON_DATABASE_URL ? ") || db.includes("useNeon ? process.env.NEON_DATABASE_URL"), "the app prefers Neon");
assert.ok(db.includes("WARNING: NEON_DATABASE_URL is not set"), "and warns loudly if the Neon setting is missing");
assert.ok(!fs.existsSync("scripts/copy-to-neon.mjs"), "the one-time copy script is retired");
assert.ok(fs.existsSync("DATABASE.md"), "the note about where the data lives exists");
const pkg = fs.readFileSync("package.json", "utf8");
assert.ok(pkg.includes("DATABASE_URL=${NEON_DATABASE_URL:-$DATABASE_URL}"), "database updates at startup still run against Neon");
console.log("Database setup: all checks passed");
