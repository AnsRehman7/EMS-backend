const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { env } = require("../config/env");

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is required to initialize Prisma.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.databaseUrl }),
  log: env.nodeEnv === "development" ? ["error", "warn"] : ["error"],
});

module.exports = prisma;
