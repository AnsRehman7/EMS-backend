const { firebaseAppCheck, firebaseAuth } = require("../config/firebaseAdmin");
const { env } = require("../config/env");
const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");

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

const attachCurrentUser = async (req, _res, next) => {
  try {
    const currentUser = await prisma.user.findUnique({
      include: {
        organization: true,
      },
      where: { firebaseUid: req.firebaseUser.uid },
    });

    if (!currentUser) {
      throw new ApiError(404, "User profile is not synced yet.");
    }

    if (currentUser.status === "SUSPENDED") {
      throw new ApiError(403, "This account is suspended. Contact your workspace administrator.");
    }

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
};
