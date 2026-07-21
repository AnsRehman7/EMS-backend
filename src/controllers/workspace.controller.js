const workspaceService = require("../services/workspace.service");
const asyncHandler = require("../utils/asyncHandler");
const { parseBody, updateWorkspaceSettingsSchema } = require("../utils/validators");

const getSettings = asyncHandler(async (req, res) => {
  const settings = await workspaceService.getWorkspaceSettings(req.user);
  res.status(200).json({ data: settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const payload = parseBody(updateWorkspaceSettingsSchema, req.body);
  const settings = await workspaceService.updateWorkspaceSettings(req.user, payload);
  res.status(200).json({ data: settings });
});

module.exports = { getSettings, updateSettings };
