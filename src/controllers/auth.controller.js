const asyncHandler = require("../utils/asyncHandler");
const { parseBody, syncProfileSchema } = require("../utils/validators");
const userService = require("../services/user.service");

const syncProfile = asyncHandler(async (req, res) => {
  const payload = parseBody(syncProfileSchema, req.body);
  const user = await userService.syncUserProfile(req.firebaseUser, payload);

  res.status(200).json({ data: { user } });
});

const getMe = asyncHandler(async (req, res) => {
  res.status(200).json({ data: { user: userService.getCurrentUser(req.user) } });
});

module.exports = {
  getMe,
  syncProfile,
};
