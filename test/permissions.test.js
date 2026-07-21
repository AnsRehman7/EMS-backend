const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getPermissionCatalog,
  getRolePermissions,
  hasPermission,
  PERMISSIONS,
  resolvePermissions,
} = require("../src/utils/permissions");

test("role defaults preserve attendance and reporting boundaries", () => {
  assert.equal(hasPermission({ role: "SUPER_ADMIN" }, PERMISSIONS.SETTINGS_MANAGE), true);
  assert.equal(hasPermission({ role: "ADMIN" }, PERMISSIONS.BILLING_MANAGE), false);
  assert.equal(hasPermission({ role: "HR" }, PERMISSIONS.ATTENDANCE_VIEW_ALL), true);
  assert.equal(hasPermission({ role: "ACCOUNTS" }, PERMISSIONS.ATTENDANCE_VIEW_ALL), true);
  assert.equal(hasPermission({ role: "MANAGER" }, PERMISSIONS.ATTENDANCE_VIEW_ALL), false);
  assert.equal(hasPermission({ role: "EMPLOYEE" }, PERMISSIONS.TASKS_VIEW_ALL), false);
});

test("custom permissions replace role defaults", () => {
  const user = {
    customPermissions: [PERMISSIONS.PROJECTS_VIEW_ALL, "unsupported.permission"],
    role: "ADMIN",
    usesCustomPermissions: true,
  };

  assert.deepEqual(resolvePermissions(user), [PERMISSIONS.PROJECTS_VIEW_ALL]);
  assert.equal(hasPermission(user, PERMISSIONS.USERS_MANAGE), false);
});

test("permission catalog and role defaults contain known unique keys", () => {
  const catalog = getPermissionCatalog();
  const knownKeys = catalog.permissions.map(({ key }) => key);

  assert.equal(new Set(knownKeys).size, knownKeys.length);
  Object.values(catalog.roleDefaults).forEach((permissions) => {
    assert.equal(new Set(permissions).size, permissions.length);
    permissions.forEach((permission) => assert.ok(knownKeys.includes(permission)));
  });
  assert.deepEqual(catalog.roleDefaults.super_admin, getRolePermissions("SUPER_ADMIN"));
});
