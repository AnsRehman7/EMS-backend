const { createHmac, randomInt, timingSafeEqual } = require("crypto");
const prisma = require("../db/prisma");
const { env } = require("../config/env");
const { firebaseAuth, firebaseAuthMode } = require("../config/firebaseAdmin");
const ApiError = require("../utils/apiError");
const { safelyRecordAudit } = require("./audit.service");
const { sendSignInCodeEmail } = require("./mail.service");

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
 * reversible from a database dump. HMAC with a server-side secret keeps the stored
 * value useless without that secret, which never lives in the database.
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
  const now = new Date();
  const cooldownMs = env.otpCooldownSeconds * 1000;

  const [recent, hourlyCount] = await Promise.all([
    prisma.loginOtp.findFirst({
      orderBy: { createdAt: "desc" },
      where: { createdAt: { gt: new Date(now.getTime() - cooldownMs) }, email: normalizedEmail },
    }),
    prisma.loginOtp.count({
      where: { createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) }, email: normalizedEmail },
    }),
  ]);

  if (recent) {
    const waitSeconds = Math.max(1, Math.ceil((cooldownMs - (now.getTime() - recent.createdAt.getTime())) / 1000));
    throw new ApiError(429, `Please wait ${waitSeconds} seconds before requesting another code.`);
  }

  if (hourlyCount >= env.otpMaxPerHour) {
    throw new ApiError(429, "Too many sign-in codes requested for this email. Try again later.");
  }

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + env.otpTtlMinutes * 60 * 1000);

  // A row is written even when no account matches, so timing and throttling behave
  // identically for unknown emails and cannot be used to enumerate accounts.
  await prisma.$transaction([
    prisma.loginOtp.deleteMany({
      where: { email: normalizedEmail, expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    }),
    prisma.loginOtp.updateMany({
      data: { consumedAt: now },
      where: { consumedAt: null, email: normalizedEmail },
    }),
    prisma.loginOtp.create({
      data: {
        codeHash: hashCode(normalizedEmail, code),
        email: normalizedEmail,
        expiresAt,
        requestIp: ip || null,
        userId: user?.id || null,
      },
    }),
  ]);

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
  const now = new Date();

  const record = await prisma.loginOtp.findFirst({
    orderBy: { createdAt: "desc" },
    where: { consumedAt: null, email: normalizedEmail, expiresAt: { gt: now } },
  });

  if (!record) throw new ApiError(400, INVALID_CODE_MESSAGE);

  const attempted = await prisma.loginOtp.update({
    data: { attempts: { increment: 1 } },
    where: { id: record.id },
  });

  if (attempted.attempts > env.otpMaxAttempts) {
    await prisma.loginOtp.updateMany({
      data: { consumedAt: now },
      where: { consumedAt: null, id: record.id },
    });
    throw new ApiError(429, "Too many incorrect codes. Request a new one.");
  }

  if (!hashesMatch(attempted.codeHash, hashCode(normalizedEmail, String(code).trim()))) {
    throw new ApiError(400, INVALID_CODE_MESSAGE);
  }

  const claimed = await prisma.loginOtp.updateMany({
    data: { consumedAt: now },
    where: { consumedAt: null, id: record.id },
  });

  if (claimed.count !== 1) throw new ApiError(409, "That code was already used. Request a new one.");

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
    metadata: { ip: ip || null, method: "email_otp" },
    summary: `${user.fullName} signed in with an email code`,
  });

  return { customToken, sessionDays: env.sessionMaxDays };
};

module.exports = {
  requestSignInCode,
  verifySignInCode,
};
