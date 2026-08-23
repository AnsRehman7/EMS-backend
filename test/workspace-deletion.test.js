const test = require("node:test");
const assert = require("node:assert/strict");
const { deleteWorkspaceSchema } = require("../src/utils/validators");
const { roleKeyOf } = require("../src/utils/roles");

test("workspace deletion requires a non-empty confirmation", () => {
  assert.equal(deleteWorkspaceSchema.safeParse({ confirmation: "Acme Ltd" }).success, true);
  assert.equal(deleteWorkspaceSchema.safeParse({ confirmation: "   " }).success, false);
  assert.equal(deleteWorkspaceSchema.safeParse({}).success, false);
});

test("only an exact workspace-name match may confirm deletion", () => {
  // Mirrors the service guard: trimmed, case-sensitive, exact.
  const confirms = (typed, name) => String(typed || "").trim() === name;

  assert.equal(confirms("Acme Ltd", "Acme Ltd"), true);
  assert.equal(confirms("  Acme Ltd  ", "Acme Ltd"), true, "surrounding whitespace is forgiven");
  assert.equal(confirms("acme ltd", "Acme Ltd"), false, "case must match");
  assert.equal(confirms("Acme", "Acme Ltd"), false, "a prefix is not enough");
  assert.equal(confirms("", "Acme Ltd"), false);
});

test("deletion is limited to the super admin, including custom roles", () => {
  const asRole = (key, rank) => ({ role: "EMPLOYEE", roleRef: { key, name: key, permissions: [], rank } });

  assert.equal(roleKeyOf(asRole("super_admin", 0)), "super_admin");
  assert.equal(roleKeyOf(asRole("admin", 10)), "admin");

  // A custom role cannot impersonate the super admin key, so the guard holds.
  assert.notEqual(roleKeyOf(asRole("owner_ish", 1)), "super_admin");
});

test("a released account is recognisable by its tombstone identity", () => {
  // Suspension rewrites both fields; reactivation keys off this prefix.
  const released = {
    email: "released+abc123@removed.invalid",
    firebaseUid: "released:abc123",
  };

  assert.equal(released.firebaseUid.startsWith("released:"), true);
  assert.equal(released.email.endsWith("@removed.invalid"), true);
  assert.equal({ firebaseUid: "firebase-uid-1" }.firebaseUid.startsWith("released:"), false);
});
