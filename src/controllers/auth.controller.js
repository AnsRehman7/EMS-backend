const asyncHandler = require("../utils/asyncHandler");
const { parseBody, syncProfileSchema, updateCurrentProfileSchema } = require("../utils/validators");
const userService = require("../services/user.service");

const syncProfile = asyncHandler(async (req, res) => {
  const payload = parseBody(syncProfileSchema, req.body);
  const user = await userService.syncUserProfile(req.firebaseUser, payload);

  res.status(200).json({ data: { user } });
});

const getMe = asyncHandler(async (req, res) => {
  res.status(200).json({ data: { user: userService.getCurrentUser(req.user) } });
});

const updateMe = asyncHandler(async (req, res) => {
  const payload = parseBody(updateCurrentProfileSchema, req.body);
  const user = await userService.updateCurrentProfile(req.user, payload);
  res.status(200).json({ data: { user } });
});

module.exports = {
  getMe,
  syncProfile,
  updateMe,
};
