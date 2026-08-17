const { firebaseAppCheck, firebaseAuth } = require("../config/firebaseAdmin");
const { env } = require("../config/env");
const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { USER_ROLES } = require("../utils/roles");

const getBearerToken = (req) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new ApiError(401, "Authentication token is required.");
  }

  return token;
};

const authenticateFirebase = async (req, _res, next) => {
  try {
    const decodedToken = await firebaseAuth.verifyIdToken(getBearerToken(req));
    req.firebaseUser = decodedToken;
    next();
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }

    next(new ApiError(401, "Invalid or expired authentication token."));
  }
};

/**
 * Firebase ID tokens live one hour and refresh silently, so the workspace session
 * length is enforced from `auth_time` (the original sign-in, which refreshes do not
 * move) rather than from token expiry.
 *
 * Sign-in method is enforced here too: email codes mint a custom token, so `custom`
 * is the normal path. Password sign-in survives only for the super admin as a
 * break-glass route in case email delivery fails.
 */
const enforceSessionPolicy = (decodedToken, currentUser) => {
  const authTimeSeconds = Number(decodedToken?.auth_time || 0);
  const maxAgeSeconds = env.sessionMaxDays * 24 * 60 * 60;

  if (authTimeSeconds && Date.now() / 1000 - authTimeSeconds > maxAgeSeconds) {
    throw new ApiError(401, `Your ${env.sessionMaxDays}-day session expired. Sign in again to continue.`);
  }

  const provider = String(decodedToken?.firebase?.sign_in_provider || "");

  if (provider === "custom") return;

  if (provider === "password") {
    if (currentUser.role !== USER_ROLES.SUPER_ADMIN) {
      throw new ApiError(401, "Password sign-in is disabled. Sign in with the code sent to your email.");
    }
    return;
  }

  throw new ApiError(401, "This sign-in method is no longer supported. Sign in with the code sent to your email.");
};

const attachCurrentUser = async (req, _res, next) => {
  try {
    const currentUser = await prisma.user.findUnique({
      include: {
        organization: true,
        roleRef: true,
      },
      where: { firebaseUid: req.firebaseUser.uid },
    });

    if (!currentUser) {
      throw new ApiError(404, "User profile is not synced yet.");
    }

    if (currentUser.status === "SUSPENDED") {
      throw new ApiError(403, "This account is suspended. Contact your workspace administrator.");
    }

    enforceSessionPolicy(req.firebaseUser, currentUser);

    req.user = currentUser;
    next();
  } catch (error) {
    next(error);
  }
};

const verifyAppCheck = async (req, _res, next) => {
  if (!env.requireAppCheck) return next();
  if (!firebaseAppCheck) return next(new ApiError(503, "Firebase App Check is required but unavailable."));
  const token = String(req.headers["x-firebase-appcheck"] || "").trim();
  if (!token) return next(new ApiError(401, "A valid app attestation token is required."));
  try {
    req.appCheck = await firebaseAppCheck.verifyToken(token);
    return next();
  } catch {
    return next(new ApiError(401, "Invalid app attestation token."));
  }
};

const authenticate = [authenticateFirebase, verifyAppCheck, attachCurrentUser];

module.exports = {
  authenticate,
  authenticateFirebase,
  enforceSessionPolicy,
};
