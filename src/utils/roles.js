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

const normalizeRole = (role) => {
  const value = String(role || "").trim().toUpperCase();
  return Object.values(USER_ROLES).includes(value) ? value : USER_ROLES.EMPLOYEE;
};

const toClientRole = (role) => String(role || USER_ROLES.EMPLOYEE).toLowerCase();

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

const canAssignRole = (actor, targetRole) => {
  const normalizedTargetRole = normalizeRole(targetRole);

  if (actor?.role === USER_ROLES.SUPER_ADMIN) {
    return true;
  }

  if (actor?.role === USER_ROLES.ADMIN) {
    return normalizedTargetRole !== USER_ROLES.SUPER_ADMIN;
  }

  if (actor?.role === USER_ROLES.HR) {
    return normalizedTargetRole === USER_ROLES.EMPLOYEE;
  }

  return false;
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
  normalizeRole,
  ORGANIZATION_WORK_VIEW_ROLES,
  toClientRole,
  USER_ROLES,
  USER_MANAGEMENT_ROLES,
  WORK_MANAGEMENT_ROLES,
};
