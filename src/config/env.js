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
  mailFromAddress: process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER,
  mailFromName: process.env.MAIL_FROM_NAME || "StaffFlow",
  nodeEnv: process.env.NODE_ENV || "development",
  otpCooldownSeconds: toNumber(process.env.OTP_COOLDOWN_SECONDS, 60),
  otpMaxAttempts: toNumber(process.env.OTP_MAX_ATTEMPTS, 5),
  otpMaxPerHour: toNumber(process.env.OTP_MAX_PER_HOUR, 8),
  otpSecret: process.env.OTP_SECRET,
  otpTtlMinutes: toNumber(process.env.OTP_TTL_MINUTES, 10),
  sessionMaxDays: toNumber(process.env.SESSION_MAX_DAYS, 3),
  smtpHost: process.env.SMTP_HOST,
  smtpPassword: process.env.SMTP_PASSWORD,
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

const validateEnv = () => {
  const missing = [];
  const hasAdminCredential = Boolean(
    env.firebaseServiceAccountJson ||
      env.firebaseServiceAccountBase64 ||
      (env.firebaseProjectId && env.firebaseClientEmail && env.firebasePrivateKey) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
  const hasRestCredential = Boolean(env.firebaseProjectId && env.firebaseWebApiKey);

  if (!hasAdminCredential && !hasRestCredential) {
    missing.push(
      "Firebase server auth: add FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_BASE64, split service-account fields, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_WEB_API_KEY with FIREBASE_PROJECT_ID"
    );
  }

  if (!hasAdminCredential && hasRestCredential) {
    console.warn("[env] Firebase Admin credentials are not set; using Firebase Auth REST fallback for local development.");
  }

  if (!env.smtpHost || !env.mailFromAddress) {
    const message = "[env] SMTP is not configured; sign-in codes cannot be emailed. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and MAIL_FROM_ADDRESS.";
    if (env.nodeEnv === "production") missing.push("SMTP_HOST and MAIL_FROM_ADDRESS are required to deliver sign-in codes");
    else console.warn(`${message} Codes will be logged to the server console in development.`);
  }

  if (env.nodeEnv === "production") {
    if (!hasAdminCredential) missing.push("Firebase Admin credentials are required in production");
    if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
    if (env.corsOrigins.includes("*")) missing.push("CORS_ORIGIN cannot contain * in production");
    if (!env.otpSecret) missing.push("OTP_SECRET (a long random string) is required to hash sign-in codes");
  }

  if (missing.length) {
    const message = `[env] Missing or unsafe runtime config: ${missing.join(", ")}`;
    if (env.nodeEnv === "production") throw new Error(message);
    console.warn(message);
  }
};

module.exports = {
  env,
  validateEnv,
};
