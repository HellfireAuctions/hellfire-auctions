import { PrismaClient } from "@prisma/client";

// The production database is Neon: NEON_DATABASE_URL must be set on the server. DATABASE_URL is only a fallback for local
// development (the old Render database was retired in October 2026; see DATABASE.md).
const useNeon = Boolean(process.env.NEON_DATABASE_URL);
// Prisma's default pool is tiny on a small server (a handful of connections), so a rush of simultaneous shoppers queues behind it.
// Unless the address already sets a limit, allow a roomier pool.
export function withPool(url, limit = 15) {
  if (!url || /[?&]connection_limit=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "connection_limit=" + limit + "&pool_timeout=20";
}
const datasourceUrl = withPool(useNeon ? process.env.NEON_DATABASE_URL : process.env.DATABASE_URL);

function create() {
  return new PrismaClient({ datasourceUrl });
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) global.prismaGlobal = create();
}

const prisma = global.prismaGlobal ?? create();

if (!globalThis.__HELLFIRE_DB_LOGGED__) {
  globalThis.__HELLFIRE_DB_LOGGED__ = true;
  if (useNeon) console.log("[db] using Neon database");
  else console.error("[db] WARNING: NEON_DATABASE_URL is not set, so the app is using DATABASE_URL. In production this must be Neon.");
}

export default prisma;
