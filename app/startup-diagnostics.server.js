// Read-only startup diagnostics. Logs which database migrations have been applied,
// so schema changes can be rolled out safely. Never writes anything.
import prisma from "./db.server.js";

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

if (!globalThis.__HELLFIRE_DIAGNOSTICS_RAN__) {
  globalThis.__HELLFIRE_DIAGNOSTICS_RAN__ = true;
  logMigrationState();
}
