const { hasPermission, PERMISSIONS } = require("./permissions");

const USER_ROLES = {
  ADMIN: "ADMIN",
  ACCOUNTS: "ACCOUNTS",
  EMPLOYEE: "EMPLOYEE",
  HR: "HR",
  MANAGER: "MANAGER",
  SUPER_ADMIN: "SUPER_ADMIN",
};

const WORK_MANAGEMENT_ROLES = [USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.MANAGER, USER_ROLES.HR];
const ORGANIZATION_WORK_VIEW_ROLES = [...WORK_MANAGEMENT_ROLES, USER_ROLES.ACCOUNTS];
const USER_MANAGEMENT_ROLES = [USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.HR];
const BILLING_MANAGEMENT_ROLES = [USER_ROLES.SUPER_ADMIN];
const ATTENDANCE_VIEW_ALL_ROLES = [USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.HR, USER_ROLES.ACCOUNTS];
const ATTENDANCE_MANAGEMENT_ROLES = [USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.HR];

/**
 * Seniority ladder. Lower is more senior, and every guard compares ranks rather than
 * role identity so custom roles slot into the same hierarchy as the built-ins.
 */
const SYSTEM_ROLE_RANKS = Object.freeze({
  accounts: 30,
  admin: 10,
  employee: 40,
  hr: 20,
  manager: 20,
  super_admin: 0,
});

const LOWEST_RANK = 100;

const normalizeRole = (role) => {
  const value = String(role || "").trim().toUpperCase();
  return Object.values(USER_ROLES).includes(value) ? value : USER_ROLES.EMPLOYEE;
};

const toClientRole = (role) => String(role || USER_ROLES.EMPLOYEE).toLowerCase();

/** The role key actually in force: the assigned role record, else the legacy enum. */
const roleKeyOf = (user) => (user?.roleRef?.key ? user.roleRef.key : toClientRole(user?.role));

const rankOf = (user) => {
  if (Number.isFinite(user?.roleRef?.rank)) return user.roleRef.rank;
  const key = toClientRole(user?.role);
  return SYSTEM_ROLE_RANKS[key] ?? LOWEST_RANK;
};

/** True when `actor` is strictly more senior than `rank`. Equal ranks cannot manage each other. */
const outranks = (actor, rank) => rankOf(actor) < Number(rank ?? LOWEST_RANK);

const canManageBilling = (user) => hasPermission(user, PERMISSIONS.BILLING_MANAGE);
const canManageAttendance = (user) => hasPermission(user, PERMISSIONS.ATTENDANCE_MANAGE);
const canManageUsers = (user) => hasPermission(user, PERMISSIONS.USERS_MANAGE);
const canViewOrganizationAttendance = (user) => hasPermission(user, PERMISSIONS.ATTENDANCE_VIEW_ALL);
const canManageWork = (user) =>
  [PERMISSIONS.TASKS_CREATE, PERMISSIONS.TASKS_EDIT, PERMISSIONS.PROJECTS_CREATE, PERMISSIONS.PROJECTS_EDIT].some(
    (permission) => hasPermission(user, permission),
  );
const canViewOrganizationWork = (user) =>
  hasPermission(user, PERMISSIONS.TASKS_VIEW_ALL) || hasPermission(user, PERMISSIONS.PROJECTS_VIEW_ALL);
const isPrivileged = canManageWork;

/**
 * Assignment is rank-based: you may only hand out a role less senior than your own.
 * HR keeps its narrower rule of only assigning the bottom rung.
 */
const canAssignRole = (actor, targetRole) => {
  const targetRank = typeof targetRole === "object" && targetRole !== null
    ? Number(targetRole.rank ?? LOWEST_RANK)
    : SYSTEM_ROLE_RANKS[toClientRole(targetRole)] ?? LOWEST_RANK;

  if (roleKeyOf(actor) === "hr") return targetRank >= SYSTEM_ROLE_RANKS.employee;

  return outranks(actor, targetRank);
};

module.exports = {
  ATTENDANCE_MANAGEMENT_ROLES,
  ATTENDANCE_VIEW_ALL_ROLES,
  canAssignRole,
  canManageAttendance,
  canManageBilling,
  canManageUsers,
  canManageWork,
  canViewOrganizationAttendance,
  canViewOrganizationWork,
  isPrivileged,
  LOWEST_RANK,
  normalizeRole,
  ORGANIZATION_WORK_VIEW_ROLES,
  outranks,
  rankOf,
  roleKeyOf,
  SYSTEM_ROLE_RANKS,
  toClientRole,
  USER_ROLES,
  USER_MANAGEMENT_ROLES,
  WORK_MANAGEMENT_ROLES,
};
