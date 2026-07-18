const userService = require("../services/user.service");
const asyncHandler = require("../utils/asyncHandler");
const {
  createOrganizationUserSchema,
  parseBody,
  updateOrganizationUserSchema,
  updateUserRoleSchema,
  updateUserPermissionsSchema,
} = require("../utils/validators");

const listEmployees = asyncHandler(async (req, res) => {
  const employees = await userService.listEmployees(req.user);
  res.status(200).json({ data: { employees } });
});

const listUsers = asyncHandler(async (req, res) => {
  const users = await userService.listUsers(req.user);
  res.status(200).json({ data: { users } });
});

const getUserById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user, req.params.userId);
  res.status(200).json({ data: { user } });
});

const createUser = asyncHandler(async (req, res) => {
  const payload = parseBody(createOrganizationUserSchema, req.body);
  const user = await userService.createOrganizationUser(req.user, payload);

  res.status(201).json({ data: { user } });
});

const updateUser = asyncHandler(async (req, res) => {
  const payload = parseBody(updateOrganizationUserSchema, req.body);
  const user = await userService.updateOrganizationUser(req.user, req.params.userId, payload);

  res.status(200).json({ data: { user } });
});

const updateUserRole = asyncHandler(async (req, res) => {
  const payload = parseBody(updateUserRoleSchema, req.body);
  const user = await userService.updateUserRole(req.user, req.params.userId, payload.role);

  res.status(200).json({ data: { user } });
});

const getPermissionCatalog = asyncHandler(async (req, res) => {
  const catalog = userService.getWorkspacePermissionCatalog(req.user);
  res.status(200).json({ data: catalog });
});

const updateUserPermissions = asyncHandler(async (req, res) => {
  const payload = parseBody(updateUserPermissionsSchema, req.body);
  const user = await userService.updateUserPermissions(req.user, req.params.userId, payload);
  res.status(200).json({ data: { user } });
});

const deleteUser = asyncHandler(async (req, res) => {
  const user = await userService.deleteOrganizationUser(req.user, req.params.userId);
  res.status(200).json({ data: { user } });
});

module.exports = {
  createUser,
  deleteUser,
  getUserById,
  getPermissionCatalog,
  listEmployees,
  listUsers,
  updateUser,
  updateUserPermissions,
  updateUserRole,
};
