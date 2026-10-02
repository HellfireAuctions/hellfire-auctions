import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

// Neon is used once NEON_DATABASE_URL is set and the startup copy succeeded
// (the copy step leaves /tmp/hellfire-use-old-db behind if it couldn't finish).
const useNeon = Boolean(process.env.NEON_DATABASE_URL) && !existsSync("/tmp/hellfire-use-old-db");
const datasourceUrl = useNeon ? process.env.NEON_DATABASE_URL : process.env.DATABASE_URL;

function create() {
  return new PrismaClient({ datasourceUrl });
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) global.prismaGlobal = create();
}

const prisma = global.prismaGlobal ?? create();

if (!globalThis.__HELLFIRE_DB_LOGGED__) {
  globalThis.__HELLFIRE_DB_LOGGED__ = true;
  console.log("[db] using", useNeon ? "Neon database" : "Render database");
}

export default prisma;
