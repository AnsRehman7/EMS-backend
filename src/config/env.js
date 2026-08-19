const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const readFrontendEnvValue = (name) => {
  if (process.env[name]) return process.env[name];

  const frontendEnvPath = path.resolve(__dirname, "../../../frontend/.env");
  if (!fs.existsSync(frontendEnvPath)) return undefined;

  const parsed = dotenv.parse(fs.readFileSync(frontendEnvPath));
  return parsed[name];
};

const toBoolean = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const csv = (value = "") =>
  value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const csvValues = (value = "") =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const toNumber = (value, fallback = undefined) => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = {
  allowClientRoleSelection: toBoolean(process.env.ALLOW_CLIENT_ROLE_SELECTION, false),
  bootstrapAdminEmails: csv(process.env.BOOTSTRAP_ADMIN_EMAILS),
  corsOrigins: csvValues(process.env.CORS_ORIGIN || "http://localhost:5173"),
  cronSecret: process.env.CRON_SECRET,
  databaseUrl:
    process.env.DATABASE_URL || "postgresql://postgres:postgre@localhost:5432/postgres?schema=public",
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  firebaseServiceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  firebaseWebApiKey:
    process.env.FIREBASE_WEB_API_KEY ||
    process.env.VITE_FIREBASE_API_KEY ||
    readFrontendEnvValue("VITE_FIREBASE_API_KEY"),
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  // Both naming conventions are accepted so an existing .env keeps working.
  mailFromAddress: process.env.MAIL_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER,
  mailFromName: process.env.MAIL_FROM_NAME || "DayMark",
  nodeEnv: process.env.NODE_ENV || "development",
  otpCooldownSeconds: toNumber(process.env.OTP_COOLDOWN_SECONDS, 60),
  otpMaxAttempts: toNumber(process.env.OTP_MAX_ATTEMPTS, 5),
  otpMaxPerHour: toNumber(process.env.OTP_MAX_PER_HOUR, 8),
  otpSecret: process.env.OTP_SECRET,
  otpTtlMinutes: toNumber(process.env.OTP_TTL_MINUTES, 10),
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN,
  redisUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL,
  sessionMaxDays: toNumber(process.env.SESSION_MAX_DAYS, 3),
  smtpHost: process.env.SMTP_HOST,
  smtpPassword: process.env.SMTP_PASSWORD || process.env.SMTP_PASS,
  smtpPort: toNumber(process.env.SMTP_PORT, 587),
  smtpSecure: toBoolean(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER,
  officeLatitude: toNumber(process.env.OFFICE_LATITUDE),
  officeLongitude: toNumber(process.env.OFFICE_LONGITUDE),
  officeRadiusMeters: toNumber(process.env.OFFICE_RADIUS_METERS, 100),
  outboxBatchSize: toNumber(process.env.OUTBOX_BATCH_SIZE, 25),
  port: Number(process.env.PORT || 4000),
  rateLimitMax: toNumber(process.env.RATE_LIMIT_MAX, 180),
  authRateLimitMax: toNumber(process.env.AUTH_RATE_LIMIT_MAX, 30),
  requireAppCheck: toBoolean(process.env.REQUIRE_FIREBASE_APP_CHECK, false),
};

/**
 * Splits configuration problems into the ones that make the API unsafe or unable to
 * serve anything (fatal) and the ones that only disable a feature (warnings).
 *
 * Missing mail/OTP configuration is deliberately NOT fatal: `mail.service` and
 * `otp.service` both refuse to operate in production without it, so sign-in already
 * fails closed. Refusing to boot over it would additionally take down attendance,
 * tasks, projects, and every session that is already valid.
 */
const collectConfigIssues = (config = env, processEnv = process.env) => {
  const fatal = [];
  const warnings = [];
  const isProduction = config.nodeEnv === "production";

  const hasAdminCredential = Boolean(
    config.firebaseServiceAccountJson ||
      config.firebaseServiceAccountBase64 ||
      (config.firebaseProjectId && config.firebaseClientEmail && config.firebasePrivateKey) ||
      processEnv.GOOGLE_APPLICATION_CREDENTIALS
  );
  const hasRestCredential = Boolean(config.firebaseProjectId && config.firebaseWebApiKey);

  if (!hasAdminCredential && !hasRestCredential) {
    fatal.push(
      "Firebase server auth: add FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_BASE64, split service-account fields, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_WEB_API_KEY with FIREBASE_PROJECT_ID"
    );
  }

  if (!hasAdminCredential && hasRestCredential) {
    warnings.push("Firebase Admin credentials are not set; using the Firebase Auth REST fallback. Email sign-in codes cannot be issued in this mode.");
  }

  if (!config.redisUrl || !config.redisToken) {
    warnings.push(
      "Upstash Redis is not configured; sign-in codes fall back to the login_otps table. Set REDIS_URL and REDIS_REST_TOKEN to use Redis."
    );
  }

  if (!config.smtpHost || !config.mailFromAddress) {
    warnings.push(
      isProduction
        ? "SMTP is not configured, so sign-in codes cannot be delivered and every code request will fail with 503. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and MAIL_FROM_ADDRESS."
        : "SMTP is not configured; sign-in codes will be logged to this console instead of emailed."
    );
  }

  if (isProduction) {
    if (!hasAdminCredential) fatal.push("Firebase Admin credentials are required in production");
    if (!processEnv.DATABASE_URL) fatal.push("DATABASE_URL");
    if (config.corsOrigins.includes("*")) fatal.push("CORS_ORIGIN cannot contain * in production");
    if (!config.otpSecret) {
      warnings.push(
        "OTP_SECRET is not set, so sign-in codes cannot be hashed and every sign-in attempt will fail. Set it to a long random string."
      );
    }
  }

  return { fatal, warnings };
};

const validateEnv = () => {
  const { fatal, warnings } = collectConfigIssues();

  warnings.forEach((warning) => console.warn(`[env] ${warning}`));

  if (fatal.length) {
    const message = `[env] Missing or unsafe runtime config: ${fatal.join(", ")}`;
    if (env.nodeEnv === "production") throw new Error(message);
    console.warn(message);
  }
};

module.exports = {
  collectConfigIssues,
  env,
  validateEnv,
};
