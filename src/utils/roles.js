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

const canManageBilling = (user) => BILLING_MANAGEMENT_ROLES.includes(user?.role);
const canManageAttendance = (user) => ATTENDANCE_MANAGEMENT_ROLES.includes(user?.role);
const canManageUsers = (user) => USER_MANAGEMENT_ROLES.includes(user?.role);
const canViewOrganizationAttendance = (user) => ATTENDANCE_VIEW_ALL_ROLES.includes(user?.role);
const canManageWork = (user) => WORK_MANAGEMENT_ROLES.includes(user?.role);
const canViewOrganizationWork = (user) => ORGANIZATION_WORK_VIEW_ROLES.includes(user?.role);
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
