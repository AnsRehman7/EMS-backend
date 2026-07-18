const PERMISSIONS = Object.freeze({
  ATTENDANCE_MANAGE: "attendance.manage",
  ATTENDANCE_VIEW_ALL: "attendance.view_all",
  BILLING_MANAGE: "billing.manage",
  DASHBOARD_VIEW: "dashboard.view",
  PERMISSIONS_MANAGE: "permissions.manage",
  PROJECTS_CREATE: "projects.create",
  PROJECTS_DELETE: "projects.delete",
  PROJECTS_EDIT: "projects.edit",
  PROJECTS_VIEW_ALL: "projects.view_all",
  TASKS_CREATE: "tasks.create",
  TASKS_DELETE: "tasks.delete",
  TASKS_EDIT: "tasks.edit",
  TASKS_VIEW_ALL: "tasks.view_all",
  USERS_MANAGE: "users.manage",
  USERS_VIEW: "users.view",
});

const PERMISSION_CATALOG = Object.freeze([
  {
    description: "Open the organization analytics dashboard.",
    group: "Workspace",
    key: PERMISSIONS.DASHBOARD_VIEW,
    label: "View executive dashboard",
  },
  {
    description: "View every task in the workspace instead of assigned tasks only.",
    group: "Tasks",
    key: PERMISSIONS.TASKS_VIEW_ALL,
    label: "View all tasks",
  },
  {
    description: "Create tasks and assign them to team members.",
    group: "Tasks",
    key: PERMISSIONS.TASKS_CREATE,
    label: "Create and assign tasks",
  },
  {
    description: "Edit task details, assignments, and workflow state.",
    group: "Tasks",
    key: PERMISSIONS.TASKS_EDIT,
    label: "Edit all tasks",
  },
  {
    description: "Permanently remove workspace tasks.",
    group: "Tasks",
    key: PERMISSIONS.TASKS_DELETE,
    label: "Delete tasks",
  },
  {
    description: "View all workspace projects instead of related projects only.",
    group: "Projects",
    key: PERMISSIONS.PROJECTS_VIEW_ALL,
    label: "View all projects",
  },
  {
    description: "Create projects and AI-assisted delivery plans.",
    group: "Projects",
    key: PERMISSIONS.PROJECTS_CREATE,
    label: "Create projects",
  },
  {
    description: "Edit project briefs, ownership, schedules, and status.",
    group: "Projects",
    key: PERMISSIONS.PROJECTS_EDIT,
    label: "Edit projects",
  },
  {
    description: "Delete empty projects or archive projects containing work.",
    group: "Projects",
    key: PERMISSIONS.PROJECTS_DELETE,
    label: "Delete or archive projects",
  },
  {
    description: "View attendance records for every workspace member.",
    group: "People",
    key: PERMISSIONS.ATTENDANCE_VIEW_ALL,
    label: "View all attendance",
  },
  {
    description: "Record or correct attendance on behalf of team members.",
    group: "People",
    key: PERMISSIONS.ATTENDANCE_MANAGE,
    label: "Manage attendance",
  },
  {
    description: "View the workspace directory and account details.",
    group: "People",
    key: PERMISSIONS.USERS_VIEW,
    label: "View users",
  },
  {
    description: "Create, edit, suspend, and reactivate permitted accounts.",
    group: "People",
    key: PERMISSIONS.USERS_MANAGE,
    label: "Manage users",
  },
  {
    description: "Customize access permissions for workspace accounts.",
    group: "Administration",
    key: PERMISSIONS.PERMISSIONS_MANAGE,
    label: "Manage permissions",
  },
  {
    description: "Manage subscription and billing settings.",
    group: "Administration",
    key: PERMISSIONS.BILLING_MANAGE,
    label: "Manage billing",
  },
]);

const allPermissions = PERMISSION_CATALOG.map(({ key }) => key);

const ROLE_PERMISSIONS = Object.freeze({
  SUPER_ADMIN: allPermissions,
  ADMIN: allPermissions.filter((permission) => permission !== PERMISSIONS.BILLING_MANAGE),
  MANAGER: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.TASKS_VIEW_ALL,
    PERMISSIONS.TASKS_CREATE,
    PERMISSIONS.TASKS_EDIT,
    PERMISSIONS.TASKS_DELETE,
    PERMISSIONS.PROJECTS_VIEW_ALL,
    PERMISSIONS.PROJECTS_CREATE,
    PERMISSIONS.PROJECTS_EDIT,
    PERMISSIONS.PROJECTS_DELETE,
  ],
  HR: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.TASKS_VIEW_ALL,
    PERMISSIONS.TASKS_CREATE,
    PERMISSIONS.TASKS_EDIT,
    PERMISSIONS.PROJECTS_VIEW_ALL,
    PERMISSIONS.PROJECTS_CREATE,
    PERMISSIONS.PROJECTS_EDIT,
    PERMISSIONS.ATTENDANCE_VIEW_ALL,
    PERMISSIONS.ATTENDANCE_MANAGE,
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_MANAGE,
  ],
  ACCOUNTS: [
    PERMISSIONS.TASKS_VIEW_ALL,
    PERMISSIONS.PROJECTS_VIEW_ALL,
    PERMISSIONS.ATTENDANCE_VIEW_ALL,
  ],
  EMPLOYEE: [],
});

const isKnownPermission = (permission) => allPermissions.includes(permission);

const getRolePermissions = (role) => [...(ROLE_PERMISSIONS[String(role || "EMPLOYEE").toUpperCase()] || [])];

const resolvePermissions = (user) => {
  if (user?.usesCustomPermissions) {
    return [...new Set((user.customPermissions || []).filter(isKnownPermission))];
  }

  return getRolePermissions(user?.role);
};

const hasPermission = (user, permission) => resolvePermissions(user).includes(permission);

const getPermissionCatalog = () => ({
  permissions: PERMISSION_CATALOG,
  roleDefaults: Object.fromEntries(
    Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [role.toLowerCase(), permissions]),
  ),
});

module.exports = {
  getPermissionCatalog,
  getRolePermissions,
  hasPermission,
  isKnownPermission,
  PERMISSIONS,
  resolvePermissions,
};
