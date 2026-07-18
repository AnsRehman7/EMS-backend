require("dotenv/config");

const { defineConfig } = require("prisma/config");

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://postgres:postgre@localhost:5432/postgres?schema=public";

module.exports = defineConfig({
  datasource: {
    url: databaseUrl,
  },
  migrations: {
    path: "prisma/migrations",
  },
  schema: "prisma/schema.prisma",
});
