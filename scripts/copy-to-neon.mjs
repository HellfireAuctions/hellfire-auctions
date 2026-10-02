// One-time copy of all app data from the current (Render) database into Neon.
// Runs at startup before the app. Exit 0 = use Neon. Exit 1 = stay on the old database.
import { PrismaClient } from "@prisma/client";

const NEON = process.env.NEON_DATABASE_URL;
const OLD = process.env.DATABASE_URL;
const TABLES = ["session", "shopPlan", "auction", "bid", "auctionNotification"];
const MARKER = { auctionId: "__system__", customerId: "__system__", type: "NEON_MIGRATED", key: "1" };

if (!NEON) {
  console.log("[neon-copy] NEON_DATABASE_URL not set - using the current database");
  process.exit(1);
}

const neon = new PrismaClient({ datasourceUrl: NEON });
const old = new PrismaClient({ datasourceUrl: OLD });

async function oldSaysMigrated() {
  try {
    return Boolean(await old.auctionNotification.findFirst({ where: MARKER }));
  } catch {
    return false;
  }
}

let code = 0;
try {
  let neonRows;
  try {
    neonRows = (await neon.auction.count()) + (await neon.session.count());
  } catch (error) {
    // Neon unreachable right now: if we already moved, keep using Neon (never fall back to stale data).
    const migrated = await oldSaysMigrated();
    console.error("[neon-copy] Neon not reachable:", String(error?.message || error).split("\n").pop(), migrated ? "- already migrated, staying on Neon" : "- staying on the old database");
    code = migrated ? 0 : 1;
    throw null;
  }

  if (neonRows > 0) {
    console.log("[neon-copy] Neon already has data - no copy needed");
  } else {
    const data = {};
    for (const t of TABLES) data[t] = await old[t].findMany();
    await neon.$transaction(
      async (tx) => {
        for (const t of TABLES) if (data[t].length) await tx[t].createMany({ data: data[t] });
      },
      { timeout: 120000, maxWait: 30000 },
    );
    for (const t of TABLES) {
      const n = await neon[t].count();
      if (n !== data[t].length) throw new Error(`count mismatch for ${t}: Neon ${n} vs old ${data[t].length}`);
    }
    await old.auctionNotification.create({ data: MARKER }).catch(() => {});
    console.log("[neon-copy] copied and verified:", JSON.stringify(Object.fromEntries(TABLES.map((t) => [t, data[t].length]))));
  }
} catch (error) {
  if (error) {
    console.error("[neon-copy] FAILED - staying on the old database:", String(error?.message || error).slice(0, 400));
    code = 1;
  }
} finally {
  await neon.$disconnect().catch(() => {});
  await old.$disconnect().catch(() => {});
}
process.exit(code);
