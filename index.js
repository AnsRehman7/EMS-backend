const app = require("./src/app");
const { env, validateEnv } = require("./src/config/env");
const prisma = require("./src/db/prisma");

validateEnv();

if (process.env.VERCEL) {
  module.exports = app;
} else {
  const server = app.listen(env.port, () => {
    console.log(`StaffFlow API listening on http://localhost:${env.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received. Shutting down StaffFlow API...`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
