// Read-only startup diagnostics. Logs which database migrations have been applied,
// so schema changes can be rolled out safely. Never writes anything.
import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";

async function logMigrationState() {
  try {
    const rows = await prisma.$queryRaw`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY started_at`;
    console.log(
      "[startup-diagnostics] migrations:",
      JSON.stringify(
        rows.map((r) => ({
          name: r.migration_name,
          finished: Boolean(r.finished_at),
          rolledBack: Boolean(r.rolled_back_at),
        })),
      ),
    );
  } catch (error) {
    console.log(
      "[startup-diagnostics] no migration history table:",
      String(error?.message || error).split("\n").slice(-1)[0],
    );
  }

  try {
    const tables = await prisma.$queryRaw`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    console.log("[startup-diagnostics] tables:", tables.map((t) => t.table_name).join(", "));
  } catch (error) {
    console.log("[startup-diagnostics] table list failed:", error?.message || error);
  }
}

// Read-only: is the sending domain verified, and can the app read a bidder's email? Sends nothing.
async function checkEmailReadiness() {
  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      const json = await response.json().catch(() => ({}));
      const domains = (json?.data || []).map((d) => `${d.name}=${d.status}`).join(", ");
      console.log("[startup-diagnostics] email domain:", response.ok ? domains || "none" : `HTTP ${response.status} ${json?.name || ""}`);
    } catch (error) {
      console.log("[startup-diagnostics] email domain check failed:", error?.message || error);
    }
  }

  try {
    const bid = await prisma.bid.findFirst({ include: { auction: { select: { shop: true } } } });
    if (!bid) return console.log("[startup-diagnostics] customer email access: no bids to test with");
    const { admin } = await unauthenticated.admin(bid.auction.shop);
    const response = await admin.graphql(
      `#graphql
        query EmailAccess($id: ID!) { customer(id: $id) { email } }`,
      { variables: { id: `gid://shopify/Customer/${bid.bidderId}` } },
    );
    const json = await response.json();
    const email = json?.data?.customer?.email;
    console.log(
      "[startup-diagnostics] customer email access:",
      email ? `OK (${email.replace(/^(.).*(@.*)$/, "$1***$2")})` : `NOT AVAILABLE ${JSON.stringify(json?.errors || json?.data || {}).slice(0, 200)}`,
    );
  } catch (error) {
    console.log("[startup-diagnostics] customer email access check failed:", String(error?.message || error).slice(0, 300));
  }
}

if (!globalThis.__HELLFIRE_DIAGNOSTICS_RAN__) {
  globalThis.__HELLFIRE_DIAGNOSTICS_RAN__ = true;
  logMigrationState();
  checkEmailReadiness();
}
