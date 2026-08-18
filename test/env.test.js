const test = require("node:test");
const assert = require("node:assert/strict");
const { collectConfigIssues } = require("../src/config/env");

const productionConfig = (overrides = {}) => ({
  corsOrigins: ["https://app.example.com"],
  firebaseClientEmail: "svc@example.iam.gserviceaccount.com",
  firebasePrivateKey: "-----BEGIN PRIVATE KEY-----",
  firebaseProjectId: "staffflow",
  mailFromAddress: "no-reply@example.com",
  nodeEnv: "production",
  otpSecret: "a-long-random-secret",
  redisToken: "upstash-token",
  redisUrl: "https://example.upstash.io",
  smtpHost: "smtp.example.com",
  ...overrides,
});

const processEnv = { DATABASE_URL: "postgresql://localhost:5432/app" };

test("a fully configured production environment reports no issues", () => {
  const { fatal, warnings } = collectConfigIssues(productionConfig(), processEnv);

  assert.deepEqual(fatal, []);
  assert.deepEqual(warnings, []);
});

test("missing mail or OTP configuration warns but never blocks startup", () => {
  // Sign-in fails closed at request time, so refusing to boot would take the whole
  // API down over one broken feature.
  const { fatal, warnings } = collectConfigIssues(
    productionConfig({ mailFromAddress: undefined, otpSecret: undefined, smtpHost: undefined }),
    processEnv,
  );

  assert.deepEqual(fatal, []);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((warning) => /SMTP is not configured/.test(warning)));
  assert.ok(warnings.some((warning) => /OTP_SECRET is not set/.test(warning)));
});

test("configuration that makes the API unsafe or unable to serve is still fatal", () => {
  const missingDatabase = collectConfigIssues(productionConfig(), {});
  assert.ok(missingDatabase.fatal.includes("DATABASE_URL"));

  const wildcardCors = collectConfigIssues(productionConfig({ corsOrigins: ["*"] }), processEnv);
  assert.ok(wildcardCors.fatal.some((issue) => /CORS_ORIGIN cannot contain \*/.test(issue)));

  const noFirebase = collectConfigIssues(
    productionConfig({
      firebaseClientEmail: undefined,
      firebasePrivateKey: undefined,
      firebaseProjectId: undefined,
      firebaseWebApiKey: undefined,
    }),
    processEnv,
  );
  assert.ok(noFirebase.fatal.length > 0);
});

test("missing Redis warns and silently falls back to the database store", () => {
  const { fatal, warnings } = collectConfigIssues(
    productionConfig({ redisToken: undefined, redisUrl: undefined }),
    processEnv,
  );

  assert.deepEqual(fatal, []);
  assert.ok(warnings.some((warning) => /fall back to the login_otps table/.test(warning)));
});

test("development without SMTP is only a warning about console delivery", () => {
  const { fatal, warnings } = collectConfigIssues(
    productionConfig({ mailFromAddress: undefined, nodeEnv: "development", smtpHost: undefined }),
    processEnv,
  );

  assert.deepEqual(fatal, []);
  assert.ok(warnings.some((warning) => /logged to this console/.test(warning)));
});
