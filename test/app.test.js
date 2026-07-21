const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const prisma = require("../src/db/prisma");

const listen = () =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

test("public operational endpoints are healthy", async (context) => {
  const server = await listen();
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await prisma.$disconnect();
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const rootResponse = await fetch(`${baseUrl}/`);
  assert.equal(rootResponse.status, 200);
  assert.equal((await rootResponse.json()).data.service, "StaffFlow API");

  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.data.status, "ok");
  assert.ok(healthResponse.headers.get("x-request-id"));

  const faviconResponse = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(faviconResponse.status, 204);
});
