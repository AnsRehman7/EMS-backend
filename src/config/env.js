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

const toNumber = (value, fallback = undefined) => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = {
  allowClientRoleSelection: toBoolean(process.env.ALLOW_CLIENT_ROLE_SELECTION, false),
  bootstrapAdminEmails: csv(process.env.BOOTSTRAP_ADMIN_EMAILS),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
  databaseUrl:
    process.env.DATABASE_URL || "postgresql://postgres:postgre@localhost:5432/postgres?schema=public",
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  firebaseWebApiKey:
    process.env.FIREBASE_WEB_API_KEY ||
    process.env.VITE_FIREBASE_API_KEY ||
    readFrontendEnvValue("VITE_FIREBASE_API_KEY"),
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash",
  nodeEnv: process.env.NODE_ENV || "development",
  officeLatitude: toNumber(process.env.OFFICE_LATITUDE),
  officeLongitude: toNumber(process.env.OFFICE_LONGITUDE),
  officeRadiusMeters: toNumber(process.env.OFFICE_RADIUS_METERS, 100),
  port: Number(process.env.PORT || 4000),
};

const validateEnv = () => {
  const missing = [];
  const hasAdminCredential = Boolean(
    env.firebaseServiceAccountJson ||
      (env.firebaseProjectId && env.firebaseClientEmail && env.firebasePrivateKey) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
  const hasRestCredential = Boolean(env.firebaseProjectId && env.firebaseWebApiKey);

  if (!hasAdminCredential && !hasRestCredential) {
    missing.push(
      "Firebase server auth: add FIREBASE_SERVICE_ACCOUNT_JSON, split service-account fields, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_WEB_API_KEY with FIREBASE_PROJECT_ID"
    );
  }

  if (!hasAdminCredential && hasRestCredential) {
    console.warn("[env] Firebase Admin credentials are not set; using Firebase Auth REST fallback for local development.");
  }

  if (missing.length) {
    console.warn(`[env] Missing runtime config for authenticated routes: ${missing.join(", ")}`);
  }
};

module.exports = {
  env,
  validateEnv,
};
