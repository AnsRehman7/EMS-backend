const workspaceService = require("../services/workspace.service");
const asyncHandler = require("../utils/asyncHandler");
const { createOfficeSchema, parseBody, updateOfficeSchema, updateWorkspaceSettingsSchema } = require("../utils/validators");

const getSettings = asyncHandler(async (req, res) => {
  const settings = await workspaceService.getWorkspaceSettings(req.user);
  res.status(200).json({ data: settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const payload = parseBody(updateWorkspaceSettingsSchema, req.body);
  const settings = await workspaceService.updateWorkspaceSettings(req.user, payload);
  res.status(200).json({ data: settings });
});

const createOffice = asyncHandler(async (req, res) => {
  const office = await workspaceService.createOffice(req.user, parseBody(createOfficeSchema, req.body));
  res.status(201).json({ data: { office } });
});

const updateOffice = asyncHandler(async (req, res) => {
  const office = await workspaceService.updateOffice(
    req.user,
    req.params.officeId,
    parseBody(updateOfficeSchema, req.body),
  );
  res.status(200).json({ data: { office } });
});

const deleteOffice = asyncHandler(async (req, res) => {
  await workspaceService.deleteOffice(req.user, req.params.officeId);
  res.status(204).send();
});

module.exports = { createOffice, deleteOffice, getSettings, updateOffice, updateSettings };
