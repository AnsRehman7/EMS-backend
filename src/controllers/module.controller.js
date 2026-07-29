const moduleService = require("../services/module.service");
const asyncHandler = require("../utils/asyncHandler");
const {
  createModuleSchema,
  customFieldInputSchema,
  customRecordSchema,
  parseBody,
  updateCustomFieldSchema,
  updateModuleSchema,
} = require("../utils/validators");

const listAvailableModules = asyncHandler(async (req, res) => {
  const modules = await moduleService.listAvailableModules(req.user);
  res.status(200).json({ data: { modules } });
});

const getModuleByKey = asyncHandler(async (req, res) => {
  const module = await moduleService.getModuleByKey(req.user, req.params.moduleKey);
  res.status(200).json({ data: { module } });
});

const listCustomizationModules = asyncHandler(async (req, res) => {
  const modules = await moduleService.listCustomizationModules(req.user);
  res.status(200).json({ data: { modules } });
});

const createModule = asyncHandler(async (req, res) => {
  const payload = parseBody(createModuleSchema, req.body);
  const module = await moduleService.createModule(req.user, payload);
  res.status(201).json({ data: { module } });
});

const updateModule = asyncHandler(async (req, res) => {
  const payload = parseBody(updateModuleSchema, req.body);
  const module = await moduleService.updateModule(req.user, req.params.moduleId, payload);
  res.status(200).json({ data: { module } });
});

const createField = asyncHandler(async (req, res) => {
  const payload = parseBody(customFieldInputSchema, req.body);
  const field = await moduleService.createField(req.user, req.params.moduleId, payload);
  res.status(201).json({ data: { field } });
});

const updateField = asyncHandler(async (req, res) => {
  const payload = parseBody(updateCustomFieldSchema, req.body);
  const field = await moduleService.updateField(
    req.user,
    req.params.moduleId,
    req.params.fieldId,
    payload,
  );
  res.status(200).json({ data: { field } });
});

const archiveField = asyncHandler(async (req, res) => {
  const field = await moduleService.archiveField(
    req.user,
    req.params.moduleId,
    req.params.fieldId,
  );
  res.status(200).json({ data: { field } });
});

const listRecords = asyncHandler(async (req, res) => {
  const result = await moduleService.listRecords(req.user, req.params.moduleKey, req.query);
  res.status(200).json({ data: result });
});

const getRecord = asyncHandler(async (req, res) => {
  const result = await moduleService.getRecord(
    req.user,
    req.params.moduleKey,
    req.params.recordId,
  );
  res.status(200).json({ data: result });
});

const createRecord = asyncHandler(async (req, res) => {
  const payload = parseBody(customRecordSchema, req.body);
  const record = await moduleService.createRecord(req.user, req.params.moduleKey, payload.values);
  res.status(201).json({ data: { record } });
});

const updateRecord = asyncHandler(async (req, res) => {
  const payload = parseBody(customRecordSchema, req.body);
  const record = await moduleService.updateRecord(
    req.user,
    req.params.moduleKey,
    req.params.recordId,
    payload.values,
  );
  res.status(200).json({ data: { record } });
});

const deleteRecord = asyncHandler(async (req, res) => {
  await moduleService.deleteRecord(req.user, req.params.moduleKey, req.params.recordId);
  res.status(204).send();
});

module.exports = {
  archiveField,
  createField,
  createModule,
  createRecord,
  deleteRecord,
  getModuleByKey,
  getRecord,
  listAvailableModules,
  listCustomizationModules,
  listRecords,
  updateField,
  updateModule,
  updateRecord,
};
