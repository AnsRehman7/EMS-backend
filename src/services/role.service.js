const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const {
  isKnownPermission,
  resolvePermissions,
  ROLE_PERMISSIONS,
} = require("../utils/permissions");
const { LOWEST_RANK, outranks, rankOf, SYSTEM_ROLE_RANKS } = require("../utils/roles");
const { safelyRecordAudit } = require("./audit.service");

const SYSTEM_ROLES = [
  {
    description: "Full control of the workspace, including billing and customization.",
    key: "super_admin",
    name: "Super Admin",
  },
  { description: "Manages people, delivery, and workspace settings.", key: "admin", name: "Admin" },
  { description: "Runs delivery across tasks and projects.", key: "manager", name: "Manager" },
  { description: "Manages people, attendance, and workforce reporting.", key: "hr", name: "HR" },
  {
    description: "Read-only visibility across delivery and attendance.",
    key: "accounts",
    name: "Accounts",
  },
  { description: "Works on assigned tasks.", key: "employee", name: "Employee" },
];

const toRoleKey = (value = "") =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

const serializeRole = (role, userCount) => ({
  description: role.description || "",
  id: role.id,
  isSystem: role.isSystem,
  key: role.key,
  name: role.name,
  permissions: [...(role.permissions || [])].sort(),
  rank: role.rank,
  updatedAt: role.updatedAt,
  ...(userCount === undefined ? {} : { userCount }),
});

/** Seeds the six built-in roles for a workspace. Safe to call repeatedly. */
const ensureSystemRoles = async (client, organizationId) => {
  await client.role.createMany({
    data: SYSTEM_ROLES.map((role) => ({
      description: role.description,
      isSystem: true,
      key: role.key,
      name: role.name,
      organizationId,
      permissions: ROLE_PERMISSIONS[role.key.toUpperCase()] || [],
      rank: SYSTEM_ROLE_RANKS[role.key],
    })),
    skipDuplicates: true,
  });

  return client.role.findMany({
    orderBy: [{ rank: "asc" }, { name: "asc" }],
    where: { organizationId },
  });
};

const listRoles = async (currentUser) => {
  let roles = await prisma.role.findMany({
    orderBy: [{ rank: "asc" }, { name: "asc" }],
    where: { organizationId: currentUser.organizationId },
  });

  // Workspaces created before roles became data have none seeded yet.
  if (!roles.length) roles = await ensureSystemRoles(prisma, currentUser.organizationId);

  const counts = await prisma.user.groupBy({
    _count: { _all: true },
    by: ["roleId"],
    where: { organizationId: currentUser.organizationId },
  });
  const countByRole = new Map(counts.map((entry) => [entry.roleId, entry._count._all]));

  return roles.map((role) => ({
    ...serializeRole(role, countByRole.get(role.id) || 0),
    canManage: !role.isSystem && outranks(currentUser, role.rank),
    canAssign: outranks(currentUser, role.rank),
  }));
};

const getManageableRole = async (currentUser, roleId) => {
  const role = await prisma.role.findFirst({
    where: { id: roleId, organizationId: currentUser.organizationId },
  });

  if (!role) throw new ApiError(404, "Role not found.");
  if (role.isSystem) {
    throw new ApiError(403, `${role.name} is a built-in role and cannot be changed or removed.`);
  }
  if (!outranks(currentUser, role.rank)) {
    throw new ApiError(403, "You can only manage roles less senior than your own.");
  }

  return role;
};

/**
 * The escalation guard: a role may never carry a permission its author does not
 * already hold, so role creation cannot be used to grant yourself or anyone else
 * more access than you have.
 */
const assertGrantablePermissions = (currentUser, permissions) => {
  const requested = [...new Set(permissions || [])];
  const unknown = requested.filter((permission) => !isKnownPermission(permission));
  if (unknown.length) {
    throw new ApiError(400, `Unknown permission: ${unknown.join(", ")}.`);
  }

  const held = new Set(resolvePermissions(currentUser));
  const escalating = requested.filter((permission) => !held.has(permission));
  if (escalating.length) {
    throw new ApiError(403, `You cannot grant permissions you do not have: ${escalating.join(", ")}.`);
  }

  return requested;
};

const createRole = async (currentUser, payload) => {
  const key = toRoleKey(payload.key || payload.name);
  if (!key) throw new ApiError(400, "Enter a role name that contains letters or numbers.");

  const permissions = assertGrantablePermissions(currentUser, payload.permissions);
  // A new role always sits strictly below its author, so it can never be used to
  // reach sideways or upward in the hierarchy.
  const rank = Math.min(rankOf(currentUser) + 1, LOWEST_RANK);

  const existing = await prisma.role.findFirst({
    where: { key, organizationId: currentUser.organizationId },
  });
  if (existing) throw new ApiError(409, `A role named "${existing.name}" already exists.`);

  const role = await prisma.role.create({
    data: {
      description: payload.description || null,
      isSystem: false,
      key,
      name: payload.name.trim(),
      organizationId: currentUser.organizationId,
      permissions,
      rank,
    },
  });

  await safelyRecordAudit({
    action: "CREATED",
    actor: currentUser,
    entityId: role.id,
    entityType: "ROLE",
    metadata: { key: role.key, permissions },
    summary: `Created the ${role.name} role`,
  });

  return serializeRole(role, 0);
};

const updateRole = async (currentUser, roleId, payload) => {
  const existing = await getManageableRole(currentUser, roleId);
  const data = {};

  if (payload.name !== undefined) data.name = payload.name.trim();
  if (payload.description !== undefined) data.description = payload.description || null;
  if (payload.permissions !== undefined) {
    data.permissions = assertGrantablePermissions(currentUser, payload.permissions);
  }

  const role = await prisma.role.update({ data, where: { id: existing.id } });

  await safelyRecordAudit({
    action: "UPDATED",
    actor: currentUser,
    entityId: role.id,
    entityType: "ROLE",
    metadata: { fields: Object.keys(data) },
    summary: `Updated the ${role.name} role`,
  });

  const userCount = await prisma.user.count({ where: { roleId: role.id } });
  return serializeRole(role, userCount);
};

const deleteRole = async (currentUser, roleId) => {
  const existing = await getManageableRole(currentUser, roleId);
  const userCount = await prisma.user.count({ where: { roleId: existing.id } });

  if (userCount > 0) {
    throw new ApiError(
      409,
      `${userCount} ${userCount === 1 ? "member is" : "members are"} still assigned to ${existing.name}. Move them to another role first.`,
    );
  }

  await prisma.role.delete({ where: { id: existing.id } });

  await safelyRecordAudit({
    action: "DELETED",
    actor: currentUser,
    entityId: existing.id,
    entityType: "ROLE",
    metadata: { key: existing.key },
    summary: `Deleted the ${existing.name} role`,
  });
};

/**
 * Resolves a role key to its record for assignment, enforcing the same seniority
 * rule used everywhere else.
 */
const resolveAssignableRole = async (currentUser, roleKey) => {
  const key = toRoleKey(roleKey);
  let role = await prisma.role.findFirst({
    where: { key, organizationId: currentUser.organizationId },
  });

  if (!role) {
    await ensureSystemRoles(prisma, currentUser.organizationId);
    role = await prisma.role.findFirst({
      where: { key, organizationId: currentUser.organizationId },
    });
  }

  if (!role) throw new ApiError(400, "That role does not exist in this workspace.");

  return role;
};

/**
 * Finds members who hold a permission, whether it comes from their role or from a
 * per-account override. Recipient lookups use this instead of hardcoded role lists so
 * custom roles receive the same notifications.
 */
const findUsersWithPermission = async (organizationId, permission) =>
  prisma.user.findMany({
    select: { id: true },
    where: {
      organizationId,
      status: "ACTIVE",
      OR: [
        { usesCustomPermissions: true, customPermissions: { has: permission } },
        { usesCustomPermissions: false, roleRef: { permissions: { has: permission } } },
      ],
    },
  });

module.exports = {
  assertGrantablePermissions,
  createRole,
  deleteRole,
  ensureSystemRoles,
  findUsersWithPermission,
  listRoles,
  resolveAssignableRole,
  serializeRole,
  SYSTEM_ROLES,
  toRoleKey,
  updateRole,
};
