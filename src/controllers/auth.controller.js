const asyncHandler = require("../utils/asyncHandler");
const {
  parseBody,
  requestSignInCodeSchema,
  syncProfileSchema,
  updateCurrentProfileSchema,
  verifySignInCodeSchema,
} = require("../utils/validators");
const otpService = require("../services/otp.service");
const userService = require("../services/user.service");

const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";

const requestSignInCode = asyncHandler(async (req, res) => {
  const payload = parseBody(requestSignInCodeSchema, req.body);
  const result = await otpService.requestSignInCode({ email: payload.email, ip: clientIp(req) });

  // Always reports success for a well-formed email so the response cannot be used
  // to discover which addresses have workspace accounts.
  res.status(202).json({
    data: {
      email: payload.email,
      expiresInSeconds: result.expiresInSeconds,
      resendAfterSeconds: result.resendAfterSeconds,
    },
  });
});

const verifySignInCode = asyncHandler(async (req, res) => {
  const payload = parseBody(verifySignInCodeSchema, req.body);
  const { customToken, sessionDays } = await otpService.verifySignInCode({
    code: payload.code,
    email: payload.email,
    ip: clientIp(req),
  });

  res.status(200).json({ data: { customToken, sessionDays } });
});

const syncProfile = asyncHandler(async (req, res) => {
  const payload = parseBody(syncProfileSchema, req.body);
  const user = await userService.syncUserProfile(req.firebaseUser, payload);

  res.status(200).json({ data: { user } });
});

const getMe = asyncHandler(async (req, res) => {
  const user = await userService.getCurrentUser(req.user);
  res.status(200).json({ data: { user } });
});

const updateMe = asyncHandler(async (req, res) => {
  const payload = parseBody(updateCurrentProfileSchema, req.body);
  const user = await userService.updateCurrentProfile(req.user, payload);
  res.status(200).json({ data: { user } });
});

module.exports = {
  getMe,
  requestSignInCode,
  syncProfile,
  updateMe,
  verifySignInCode,
};
