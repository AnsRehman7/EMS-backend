const roleService = require("../services/role.service");
const asyncHandler = require("../utils/asyncHandler");
const { createRoleSchema, parseBody, updateRoleSchema } = require("../utils/validators");

const listRoles = asyncHandler(async (req, res) => {
  const roles = await roleService.listRoles(req.user);
  res.status(200).json({ data: { roles } });
});

const createRole = asyncHandler(async (req, res) => {
  const payload = parseBody(createRoleSchema, req.body);
  const role = await roleService.createRole(req.user, payload);
  res.status(201).json({ data: { role } });
});

const updateRole = asyncHandler(async (req, res) => {
  const payload = parseBody(updateRoleSchema, req.body);
  const role = await roleService.updateRole(req.user, req.params.roleId, payload);
  res.status(200).json({ data: { role } });
});

const deleteRole = asyncHandler(async (req, res) => {
  await roleService.deleteRole(req.user, req.params.roleId);
  res.status(204).send();
});

module.exports = {
  createRole,
  deleteRole,
  listRoles,
  updateRole,
};
