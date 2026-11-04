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
  assert.equal((await rootResponse.json()).data.service, "Emplytic API");

  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.data.status, "ok");
  assert.ok(healthResponse.headers.get("x-request-id"));

  const faviconResponse = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(faviconResponse.status, 204);

  const missingResponse = await fetch(`${baseUrl}/missing-route`);
  const missing = await missingResponse.json();
  assert.equal(missingResponse.status, 404);
  assert.equal(missing.error.code, "NOT_FOUND");
  assert.equal(missing.error.requestId, missingResponse.headers.get("x-request-id"));
});

const { classifyDatabaseError, errorHandler } = require("../src/middlewares/error.middleware");

/** The shape Prisma 7's pg adapter raises for a dropped schema, captured from Neon. */
const missingTable = Object.assign(new Error("The table `public.users` does not exist in the current database."), {
  code: "P2021",
  meta: { driverAdapterError: { cause: { kind: "TableDoesNotExist", originalCode: "42P01" } }, modelName: "User" },
  name: "PrismaClientKnownRequestError",
});

const respond = (error) => {
  const res = {
    json(body) {
      this.body = body;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    errorHandler(error, { method: "POST", originalUrl: "/api/auth/sync", requestId: "req-1" }, res, () => {});
  } finally {
    console.error = originalError;
  }
  return res;
};

test("a missing database schema says so instead of a bare internal error", () => {
  const res = respond(missingTable);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, "DATABASE_NOT_READY");
  assert.match(res.body.error.message, /migrations/);
  assert.equal(res.body.error.requestId, "req-1");
  assert.doesNotMatch(res.body.error.message, /public\.users/, "table names stay in the log");
});

test("database outages, duplicates, and vanished records get their own answers", () => {
  assert.equal(classifyDatabaseError({ code: "P1001", message: "Can't reach database server" }).apiCode, "DATABASE_UNAVAILABLE");
  assert.equal(classifyDatabaseError({ message: "connect ECONNREFUSED 127.0.0.1:5432" }).apiCode, "DATABASE_UNAVAILABLE");

  const duplicate = classifyDatabaseError({ code: "P2002", meta: { target: ["email"] } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.message, "A record with this email already exists.");

  assert.equal(classifyDatabaseError({ code: "P2025" }).statusCode, 404);
});

test("an unrecognised failure stays a generic 500 and never leaks its message", () => {
  const res = respond(new Error("secret internal detail"));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, "Internal server error.");
});

test("an error a service raised on purpose is never reclassified", () => {
  const ApiError = require("../src/utils/apiError");
  const res = respond(new ApiError(409, "That email is already registered."));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.message, "That email is already registered.");
});
