const { firebaseAuth } = require("../config/firebaseAdmin");
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

    next(new ApiError(401, "Invalid or expired authentication token.", error.message));
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

const authenticate = [authenticateFirebase, attachCurrentUser];

module.exports = {
  authenticate,
  authenticateFirebase,
};
