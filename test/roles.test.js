const test = require("node:test");
const assert = require("node:assert/strict");
const { assertGrantablePermissions, toRoleKey } = require("../src/services/role.service");
const { canAssignRole, outranks, rankOf, roleKeyOf, SYSTEM_ROLE_RANKS } = require("../src/utils/roles");
const { PERMISSIONS } = require("../src/utils/permissions");

const withRole = (key, permissions = []) => ({
  role: "EMPLOYEE",
  roleRef: { key, name: key, permissions, rank: SYSTEM_ROLE_RANKS[key] ?? 50 },
});

const customRole = (key, rank, permissions = []) => ({
  role: "EMPLOYEE",
  roleRef: { key, name: key, permissions, rank },
});

test("role keys are slugified into a stable, safe form", () => {
  assert.equal(toRoleKey("Shift Lead"), "shift_lead");
  assert.equal(toRoleKey("  Regional-Manager!! "), "regional_manager");
  assert.equal(toRoleKey("!!!"), "");
});

test("a role record takes precedence over the legacy enum when resolving identity", () => {
  // Custom-role members carry EMPLOYEE in the enum; the record is authoritative.
  assert.equal(roleKeyOf(customRole("shift_lead", 11)), "shift_lead");
  assert.equal(rankOf(customRole("shift_lead", 11)), 11);
  // With no record at all it falls back to the enum.
  assert.equal(roleKeyOf({ role: "ADMIN" }), "admin");
  assert.equal(rankOf({ role: "ADMIN" }), SYSTEM_ROLE_RANKS.admin);
});

test("permissions cannot be granted beyond what the author already holds", () => {
  const admin = withRole("admin", [PERMISSIONS.TASKS_CREATE, PERMISSIONS.USERS_VIEW]);

  assert.deepEqual(
    assertGrantablePermissions(admin, [PERMISSIONS.TASKS_CREATE]),
    [PERMISSIONS.TASKS_CREATE],
  );

  assert.throws(
    () => assertGrantablePermissions(admin, [PERMISSIONS.BILLING_MANAGE]),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /cannot grant permissions you do not have/i);
      return true;
    },
  );
});

test("unknown permission keys are rejected outright", () => {
  const superAdmin = withRole("super_admin", Object.values(PERMISSIONS));

  assert.throws(
    () => assertGrantablePermissions(superAdmin, ["tasks.take_over_everything"]),
    /Unknown permission/i,
  );
});

test("a per-account override, not the role, decides what its holder may grant", () => {
  const restrictedAdmin = {
    customPermissions: [PERMISSIONS.USERS_VIEW],
    role: "ADMIN",
    roleRef: { key: "admin", name: "Admin", permissions: Object.values(PERMISSIONS), rank: 10 },
    usesCustomPermissions: true,
  };

  assert.throws(
    () => assertGrantablePermissions(restrictedAdmin, [PERMISSIONS.USERS_MANAGE]),
    /cannot grant permissions you do not have/i,
  );
});

test("roles can only be assigned downward in the hierarchy", () => {
  const admin = withRole("admin");
  const manager = withRole("manager");

  assert.equal(canAssignRole(admin, { rank: SYSTEM_ROLE_RANKS.manager }), true);
  assert.equal(canAssignRole(admin, { rank: SYSTEM_ROLE_RANKS.super_admin }), false);
  // Equal rank is not enough: a manager cannot hand out another manager-level role.
  assert.equal(canAssignRole(manager, { rank: SYSTEM_ROLE_RANKS.manager }), false);
  assert.equal(canAssignRole(manager, { rank: SYSTEM_ROLE_RANKS.employee }), true);
});

test("a custom role created just below an admin cannot be used to reach the admin tier", () => {
  const admin = withRole("admin");
  const derivedRank = rankOf(admin) + 1;

  assert.equal(outranks(admin, derivedRank), true);
  // Whoever holds that derived role cannot then assign the admin tier back.
  assert.equal(canAssignRole(customRole("shift_lead", derivedRank), { rank: SYSTEM_ROLE_RANKS.admin }), false);
});

test("HR stays restricted to the lowest rung regardless of ranking", () => {
  const hr = withRole("hr");

  assert.equal(canAssignRole(hr, { rank: SYSTEM_ROLE_RANKS.employee }), true);
  assert.equal(canAssignRole(hr, { rank: SYSTEM_ROLE_RANKS.manager }), false);
  assert.equal(canAssignRole(hr, { rank: SYSTEM_ROLE_RANKS.admin }), false);
});
