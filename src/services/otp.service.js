const { createHmac, randomInt, timingSafeEqual } = require("crypto");
const prisma = require("../db/prisma");
const { env } = require("../config/env");
const { firebaseAuth, firebaseAuthMode } = require("../config/firebaseAdmin");
const ApiError = require("../utils/apiError");
const { safelyRecordAudit } = require("./audit.service");
const { sendSignInCodeEmail } = require("./mail.service");
const otpStore = require("./otpStore.service");

const CODE_LENGTH = 6;
const DEVELOPMENT_SECRET = "staffflow-development-otp-secret";
// One shared message for every failed verification so the endpoint never reveals
// whether an email exists, whether a code was issued, or which part was wrong.
const INVALID_CODE_MESSAGE = "That code is invalid or has expired. Request a new one.";

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();

const otpSecret = () => {
  if (env.otpSecret) return env.otpSecret;
  if (env.nodeEnv === "production") {
    throw new ApiError(500, "Sign-in codes are not configured. Contact your workspace administrator.");
  }
  return DEVELOPMENT_SECRET;
};

/**
 * A six-digit code is only 10^6 wide, so a bare SHA-256 digest would be trivially
 * reversible from a leaked store. HMAC with a server-side secret keeps the stored
 * value useless without that secret, which never lives in Redis or the database.
 */
const hashCode = (email, code) =>
  createHmac("sha256", otpSecret()).update(`${email}:${code}`).digest("hex");

const generateCode = () => String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

const hashesMatch = (left, right) => {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const requestSignInCode = async ({ email, ip }) => {
  const normalizedEmail = normalizeEmail(email);

  const slot = await otpStore.claimRequestSlot(normalizedEmail, {
    cooldownSeconds: env.otpCooldownSeconds,
    maxPerHour: env.otpMaxPerHour,
  });

  if (!slot.allowed) {
    throw slot.reason === "cooldown"
      ? new ApiError(429, `Please wait ${slot.waitSeconds} seconds before requesting another code.`)
      : new ApiError(429, "Too many sign-in codes requested for this email. Try again later.");
  }

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  const code = generateCode();

  // A code is stored even when no account matches, so timing and throttling behave
  // identically for unknown emails and cannot be used to enumerate accounts.
  await otpStore.saveCode(normalizedEmail, {
    codeHash: hashCode(normalizedEmail, code),
    requestIp: ip,
    ttlSeconds: env.otpTtlMinutes * 60,
    userId: user?.id,
  });

  if (user && user.status === "ACTIVE") {
    await sendSignInCodeEmail({
      code,
      expiresMinutes: env.otpTtlMinutes,
      name: user.fullName,
      to: normalizedEmail,
    });
  }

  return { expiresInSeconds: env.otpTtlMinutes * 60, resendAfterSeconds: env.otpCooldownSeconds };
};

const verifySignInCode = async ({ code, email, ip }) => {
  const normalizedEmail = normalizeEmail(email);

  const storedHash = await otpStore.readCodeHash(normalizedEmail);
  if (!storedHash) throw new ApiError(400, INVALID_CODE_MESSAGE);

  const attempts = await otpStore.recordAttempt(normalizedEmail);
  if (attempts > env.otpMaxAttempts) {
    await otpStore.invalidate(normalizedEmail);
    throw new ApiError(429, "Too many incorrect codes. Request a new one.");
  }

  if (!hashesMatch(storedHash, hashCode(normalizedEmail, String(code).trim()))) {
    throw new ApiError(400, INVALID_CODE_MESSAGE);
  }

  // Claiming is atomic, so a code can only ever be spent once even under a race.
  const claimedHash = await otpStore.claimCode(normalizedEmail);
  if (!claimedHash) throw new ApiError(409, "That code was already used. Request a new one.");
  if (!hashesMatch(claimedHash, hashCode(normalizedEmail, String(code).trim()))) {
    throw new ApiError(400, INVALID_CODE_MESSAGE);
  }

  const user = await prisma.user.findUnique({
    include: { organization: true, roleRef: true },
    where: { email: normalizedEmail },
  });

  if (!user) throw new ApiError(400, INVALID_CODE_MESSAGE);
  if (user.status === "SUSPENDED") {
    throw new ApiError(403, "This account is suspended. Contact your workspace administrator.");
  }

  if (typeof firebaseAuth.createCustomToken !== "function") {
    throw new ApiError(503, "Sign-in is temporarily unavailable. Contact your workspace administrator.");
  }

  let customToken;
  try {
    customToken = await firebaseAuth.createCustomToken(user.firebaseUid, { staffflow_signin: "otp" });
  } catch (error) {
    if (error?.code === "firebase/admin-credentials-required") {
      throw new ApiError(
        503,
        `Sign-in codes require Firebase Admin credentials (current mode: ${firebaseAuthMode}).`,
      );
    }
    throw error;
  }

  await safelyRecordAudit({
    action: "SIGNED_IN",
    actor: user,
    entityId: user.id,
    entityType: "USER",
    metadata: { ip: ip || null, method: "email_otp", store: otpStore.backend },
    summary: `${user.fullName} signed in with an email code`,
  });

  return { customToken, sessionDays: env.sessionMaxDays };
};

module.exports = {
  hashCode,
  requestSignInCode,
  verifySignInCode,
};
