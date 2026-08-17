const prisma = require("../db/prisma");
const { randomBytes } = require("crypto");
const ApiError = require("../utils/apiError");
const { firebaseAuth } = require("../config/firebaseAdmin");
const {
  getPermissionCatalog,
  getRolePermissions,
  hasPermission,
  isKnownPermission,
  PERMISSIONS,
  resolvePermissions,
} = require("../utils/permissions");
const {
  canAssignRole,
  canManageAttendance,
  canManageBilling,
  canManageUsers,
  canManageWork,
  canViewOrganizationAttendance,
  canViewOrganizationWork,
  normalizeRole,
  roleKeyOf,
  toClientRole,
  USER_ROLES,
} = require("../utils/roles");
const { safelyRecordAudit } = require("./audit.service");
const { ensureSystemRoles, resolveAssignableRole } = require("./role.service");
const {
  attachSystemCustomData,
  getSystemEntityData,
  saveSystemEntityData,
  validateSystemCustomValues,
  validateSystemFields,
} = require("./module.service");

const normalizeEmail = (email = "") => email.trim().toLowerCase();
const normalizeStatus = (status = "active") => String(status || "active").trim().toUpperCase();

const serializeUser = (user) => {
  const assignedPermissions = resolvePermissions(user);

  return {
  avatarUrl: user.avatarUrl || "",
  contact: user.contact || "",
  createdAt: user.createdAt,
  department: user.department || "",
  designation: user.designation || "",
  email: user.email,
  id: user.id,
  name: user.fullName,
  organization: user.organization
    ? {
        checkInGraceMinutes: user.organization.checkInGraceMinutes,
        checkoutWindowEnd: user.organization.checkoutWindowEnd,
        checkoutWindowStart: user.organization.checkoutWindowStart,
        id: user.organization.id,
        minimumOfficeMinutes: user.organization.minimumOfficeMinutes,
        name: user.organization.name,
        plan: String(user.organization.plan).toLowerCase(),
        slug: user.organization.slug,
        status: String(user.organization.status).toLowerCase(),
        timezone: user.organization.timezone,
        trialEndsAt: user.organization.trialEndsAt,
        weekStartsOn: user.organization.weekStartsOn,
        workingDays: user.organization.workingDays?.length ? user.organization.workingDays : [1, 2, 3, 4, 5],
        holidays: user.organization.holidays || [],
        workdayEnd: user.organization.workdayEnd,
        workdayStart: user.organization.workdayStart,
      }
    : null,
  organizationId: user.organizationId,
  permissions: {
    assigned: assignedPermissions,
    canCreateProjects: hasPermission(user, PERMISSIONS.PROJECTS_CREATE),
    canCreateTasks: hasPermission(user, PERMISSIONS.TASKS_CREATE),
    canDeleteProjects: hasPermission(user, PERMISSIONS.PROJECTS_DELETE),
    canDeleteTasks: hasPermission(user, PERMISSIONS.TASKS_DELETE),
    canEditProjects: hasPermission(user, PERMISSIONS.PROJECTS_EDIT),
    canEditTasks: hasPermission(user, PERMISSIONS.TASKS_EDIT),
    canManageAttendance: canManageAttendance(user),
    canManageBilling: canManageBilling(user),
    canManageCustomization:
      roleKeyOf(user) === "super_admin" && hasPermission(user, PERMISSIONS.CUSTOMIZATION_MANAGE),
    canManagePermissions: hasPermission(user, PERMISSIONS.PERMISSIONS_MANAGE),
    canManageSettings: hasPermission(user, PERMISSIONS.SETTINGS_MANAGE),
    canManageUsers: canManageUsers(user),
    canManageWork: canManageWork(user),
    canViewUsers: hasPermission(user, PERMISSIONS.USERS_VIEW),
    canViewDashboard: hasPermission(user, PERMISSIONS.DASHBOARD_VIEW),
    canViewAudit: hasPermission(user, PERMISSIONS.AUDIT_VIEW),
    canViewReports: hasPermission(user, PERMISSIONS.REPORTS_VIEW),
    canViewAllAttendance: canViewOrganizationAttendance(user),
    canViewOrganizationWork: canViewOrganizationWork(user),
    usesRoleDefaults: !user.usesCustomPermissions,
  },
  role: roleKeyOf(user),
  roleId: user.roleId || "",
  roleName: user.roleRef?.name || toClientRole(user.role).replace(/_/g, " "),
  roleRank: user.roleRef?.rank ?? null,
  skills: user.skills || [],
  status: String(user.status || "ACTIVE").toLowerCase(),
  uid: user.firebaseUid,
  updatedAt: user.updatedAt,
  weeklyCapacityHours: Number(user.weeklyCapacityHours || 40),
  };
};

const serializeUserWithCustomData = async (actor, user) =>
  (await attachSystemCustomData(actor, "users", [serializeUser(user)]))[0];

const slugify = (value = "") =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "workspace";

const createUniqueOrganizationSlug = async (tx, organizationName) => {
  const baseSlug = slugify(organizationName);
  let slug = baseSlug;
  let suffix = 2;

  while (await tx.organization.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
};

const trialEndsAt = () => {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return date;
};

const ensureOrganization = (currentUser) => {
  if (!currentUser?.organizationId) {
    throw new ApiError(400, "Your account is not attached to an organization.");
  }
};

const ensureActiveSuperAdminRemains = async (existingUser, nextRoleKey, nextStatus) => {
  const removesActiveSuperAdmin =
    roleKeyOf(existingUser) === "super_admin" &&
    existingUser.status === "ACTIVE" &&
    (nextRoleKey !== "super_admin" || nextStatus !== "ACTIVE");
  if (!removesActiveSuperAdmin) return;

  const candidates = await prisma.user.findMany({
    select: { customPermissions: true, usesCustomPermissions: true },
    where: {
      id: { not: existingUser.id },
      organizationId: existingUser.organizationId,
      roleRef: { key: "super_admin" },
      status: "ACTIVE",
    },
  });
  const remaining = candidates.some(
    (candidate) =>
      !candidate.usesCustomPermissions ||
      [PERMISSIONS.USERS_MANAGE, PERMISSIONS.PERMISSIONS_MANAGE].every((permission) =>
        candidate.customPermissions.includes(permission),
      ),
  );
  if (!remaining) {
    throw new ApiError(409, "Add another active super admin before changing this account.");
  }
};

const mapFirebaseAdminError = (error) => {
  const messages = {
    EMAIL_EXISTS: "A Firebase login already exists for this email.",
    INVALID_EMAIL: "Enter a valid email address.",
    OPERATION_NOT_ALLOWED: "Enable Email/Password sign-in in Firebase Authentication.",
    WEAK_PASSWORD: "Password must be at least 12 characters.",
    "auth/email-already-exists": "A Firebase login already exists for this email.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/invalid-password": "Password must be at least 12 characters.",
    "auth/user-not-found": "Firebase account was not found.",
    "firebase/admin-credentials-required": error?.message,
  };

  return messages[error?.code] || error?.message || "Firebase account operation failed.";
};

const setFirebaseClaims = async ({ firebaseUid, organizationId, role }) => {
  await firebaseAuth.setCustomUserClaims(firebaseUid, {
    organizationId,
    role: toClientRole(role),
  });
};

const syncUserProfile = async (firebaseUser, payload = {}) => {
  const firebaseUid = firebaseUser.uid;
  const email = normalizeEmail(firebaseUser.email);

  if (!email) {
    throw new ApiError(400, "Firebase account must have an email address.");
  }

  const [userByUid, userByEmail] = await Promise.all([
    prisma.user.findUnique({ include: { organization: true, roleRef: true }, where: { firebaseUid } }),
    prisma.user.findUnique({ include: { organization: true, roleRef: true }, where: { email } }),
  ]);

  if (userByUid && userByEmail && userByUid.id !== userByEmail.id) {
    throw new ApiError(409, "This Firebase identity conflicts with another workspace account. Contact an administrator.");
  }

  const existingUser = userByUid || userByEmail;

  if (existingUser) {
    if (existingUser.status === "SUSPENDED") {
      throw new ApiError(403, "This account is suspended. Contact your workspace administrator.");
    }
    if (existingUser.firebaseUid !== firebaseUid && !firebaseUser.email_verified) {
      throw new ApiError(403, "Verify this email with Google before connecting it to a workspace account.");
    }

    const synchronizedEmail =
      existingUser.email === email || firebaseUser.email_verified ? email : existingUser.email;

    const updatedUser = await prisma.user.update({
      data: {
        contact: payload.contact ?? existingUser.contact,
        department: payload.department ?? existingUser.department,
        designation: payload.designation ?? existingUser.designation,
        email: synchronizedEmail,
        firebaseUid,
        fullName: payload.fullName || existingUser.fullName,
      },
      include: {
        organization: true,
        roleRef: true,
      },
      where: { id: existingUser.id },
    });

    return serializeUserWithCustomData(updatedUser, updatedUser);
  }

  if (!payload.organizationName) {
    throw new ApiError(400, "Start a free trial to create a workspace before signing in.");
  }

  const createdUser = await prisma.$transaction(async (tx) => {
    const slug = await createUniqueOrganizationSlug(tx, payload.organizationName);
    const organization = await tx.organization.create({
      data: {
        name: payload.organizationName,
        slug,
        trialEndsAt: trialEndsAt(),
      },
    });

    const roles = await ensureSystemRoles(tx, organization.id);
    const superAdminRole = roles.find((role) => role.key === "super_admin");

    return tx.user.create({
      data: {
        contact: payload.contact || "",
        department: payload.department || "Leadership",
        designation: payload.designation || "Workspace Owner",
        email,
        firebaseUid,
        fullName: payload.fullName || firebaseUser.name || email,
        organizationId: organization.id,
        role: USER_ROLES.SUPER_ADMIN,
        roleId: superAdminRole?.id || null,
      },
      include: {
        organization: true,
        roleRef: true,
      },
    });
  });

  await setFirebaseClaims({
    firebaseUid: createdUser.firebaseUid,
    organizationId: createdUser.organizationId,
    role: createdUser.role,
  }).catch((error) => {
    console.warn("Unable to set Firebase claims for trial owner:", error.message);
  });

  await safelyRecordAudit({
    action: "CREATED",
    actor: createdUser,
    entityId: createdUser.organizationId,
    entityType: "WORKSPACE",
    metadata: { plan: "free_trial" },
    summary: `Created workspace: ${createdUser.organization.name}`,
  });

  return serializeUserWithCustomData(createdUser, createdUser);
};

const getCurrentUser = (user) => serializeUserWithCustomData(user, user);

const updateCurrentProfile = async (currentUser, payload) => {
  if (
    payload.weeklyCapacityHours !== undefined &&
    !hasPermission(currentUser, PERMISSIONS.USERS_MANAGE)
  ) {
    throw new ApiError(403, "Only workspace administrators can change weekly capacity.");
  }
  const existingCustomFields = await getSystemEntityData(currentUser, "users", currentUser.id);
  const preparedCustomFields =
    payload.customFields === undefined
      ? existingCustomFields
      : await validateSystemCustomValues({
          currentUser,
          existingValues: existingCustomFields,
          systemKey: "users",
          values: payload.customFields,
        });
  await validateSystemFields({
    currentUser,
    systemKey: "users",
    values: { ...currentUser, ...payload },
  });
  const updatedUser = await prisma.user.update({
    data: {
      ...(payload.avatarUrl !== undefined ? { avatarUrl: payload.avatarUrl || null } : {}),
      contact: payload.contact ?? currentUser.contact,
      department: payload.department ?? currentUser.department,
      designation: payload.designation ?? currentUser.designation,
      fullName: payload.fullName || currentUser.fullName,
      ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
      ...(payload.weeklyCapacityHours !== undefined ? { weeklyCapacityHours: payload.weeklyCapacityHours } : {}),
    },
    include: {
      organization: true,
      roleRef: true,
    },
    where: { id: currentUser.id },
  });

  if (payload.fullName && payload.fullName !== currentUser.fullName) {
    await firebaseAuth.updateUser(currentUser.firebaseUid, { displayName: payload.fullName }).catch((error) => {
      console.warn("Unable to update Firebase display name:", error.message);
    });
  }

  await safelyRecordAudit({
    action: "UPDATED",
    actor: currentUser,
    entityId: updatedUser.id,
    entityType: "USER",
    metadata: { fields: Object.keys(payload) },
    summary: `${updatedUser.fullName} updated their profile`,
  });

  const customFields =
    payload.customFields === undefined
      ? existingCustomFields
      : await saveSystemEntityData({
          currentUser,
          entityId: currentUser.id,
          existingValues: existingCustomFields,
          preparedData: preparedCustomFields,
          systemKey: "users",
          values: payload.customFields,
        });
  return { ...serializeUser(updatedUser), customFields };
};

const listEmployees = async (currentUser) => {
  ensureOrganization(currentUser);

  const employees = await prisma.user.findMany({
    orderBy: { fullName: "asc" },
    where: {
      organizationId: currentUser.organizationId,
      status: "ACTIVE",
    },
    include: {
      organization: true,
      roleRef: true,
    },
  });

  return attachSystemCustomData(currentUser, "users", employees.map(serializeUser));
};

const listUsers = async (currentUser) => {
  ensureOrganization(currentUser);

  const users = await prisma.user.findMany({
    orderBy: [{ role: "asc" }, { fullName: "asc" }],
    where: {
      organizationId: currentUser.organizationId,
    },
    include: {
      organization: true,
      roleRef: true,
    },
  });

  return attachSystemCustomData(currentUser, "users", users.map(serializeUser));
};

const assertCanManageUser = (actor, targetRole) => {
  if (!canManageUsers(actor)) {
    throw new ApiError(403, "You do not have permission to manage users.");
  }

  if (!canAssignRole(actor, targetRole)) {
    throw new ApiError(403, "You cannot assign that role.");
  }
};

/**
 * Resolves a role key to the workspace's role record and confirms the actor may hand
 * it out. Custom roles carry EMPLOYEE in the legacy enum column so that any code path
 * still reading the enum fails closed rather than inheriting a broader role.
 */
const resolveRoleAssignment = async (currentUser, roleKey) => {
  const role = await resolveAssignableRole(currentUser, roleKey);
  assertCanManageUser(currentUser, role);
  return { enumRole: role.isSystem ? normalizeRole(role.key) : USER_ROLES.EMPLOYEE, role };
};

const createOrganizationUser = async (currentUser, payload) => {
  ensureOrganization(currentUser);
  const { enumRole, role: roleRecord } = await resolveRoleAssignment(currentUser, payload.role);
  const role = enumRole;
  const customFields = await validateSystemCustomValues({
    currentUser,
    systemKey: "users",
    values: payload.customFields,
  });
  await validateSystemFields({
    currentUser,
    systemKey: "users",
    values: { ...payload, role, status: "ACTIVE" },
  });

  const email = normalizeEmail(payload.email);
  let firebaseUser;

  try {
    firebaseUser = await firebaseAuth.createUser({
      disabled: false,
      displayName: payload.fullName,
      email,
      emailVerified: false,
      password: payload.password || randomBytes(32).toString("base64url"),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;

    throw new ApiError(400, mapFirebaseAdminError(error), error.code);
  }

  try {
    const user = await prisma.user.create({
      data: {
        avatarUrl: payload.avatarUrl || null,
        contact: payload.contact || "",
        department: payload.department || "",
        designation: payload.designation || "",
        email,
        firebaseUid: firebaseUser.uid,
        fullName: payload.fullName,
        invitedById: currentUser.id,
        organizationId: currentUser.organizationId,
        role,
        roleId: roleRecord.id,
        skills: payload.skills || [],
        weeklyCapacityHours: payload.weeklyCapacityHours || 40,
      },
      include: {
        organization: true,
        roleRef: true,
      },
    });

    await setFirebaseClaims({
      firebaseUid: user.firebaseUid,
      organizationId: user.organizationId,
      role: user.role,
    }).catch((error) => {
      console.warn("Unable to set Firebase claims for managed user:", error.message);
    });

    await safelyRecordAudit({
      action: "CREATED",
      actor: currentUser,
      entityId: user.id,
      entityType: "USER",
      metadata: { role: toClientRole(user.role) },
      summary: `Created account for ${user.fullName}`,
    });

    const savedCustomFields = await saveSystemEntityData({
      currentUser,
      entityId: user.id,
      preparedData: customFields,
      systemKey: "users",
      values: payload.customFields,
    });
    return { ...serializeUser(user), customFields: savedCustomFields };
  } catch (error) {
    await prisma.user.deleteMany({ where: { firebaseUid: firebaseUser.uid } }).catch(() => {});
    await firebaseAuth.deleteUser(firebaseUser.uid).catch(() => {});
    throw error;
  }
};

const getManagedUser = async (currentUser, userId) => {
  ensureOrganization(currentUser);

  const user = await prisma.user.findFirst({
    include: {
      organization: true,
      roleRef: true,
    },
    where: {
      id: userId,
      organizationId: currentUser.organizationId,
    },
  });

  if (!user) {
    throw new ApiError(404, "User not found.");
  }

  return user;
};

const getUserById = async (currentUser, userId) =>
  serializeUserWithCustomData(currentUser, await getManagedUser(currentUser, userId));

const updateOrganizationUser = async (currentUser, userId, payload) => {
  const existingUser = await getManagedUser(currentUser, userId);
  const existingCustomFields = await getSystemEntityData(currentUser, "users", userId);
  const preparedCustomFields =
    payload.customFields === undefined
      ? existingCustomFields
      : await validateSystemCustomValues({
          currentUser,
          existingValues: existingCustomFields,
          systemKey: "users",
          values: payload.customFields,
        });
  const existingRoleKey = roleKeyOf(existingUser);

  if (existingRoleKey === "super_admin" && roleKeyOf(currentUser) !== "super_admin") {
    throw new ApiError(403, "Only a super admin can manage another super admin.");
  }

  const roleAssignment = payload.role ? await resolveRoleAssignment(currentUser, payload.role) : null;
  const nextRole = roleAssignment ? roleAssignment.enumRole : existingUser.role;
  const nextRoleKey = roleAssignment ? roleAssignment.role.key : existingRoleKey;
  const nextRoleId = roleAssignment ? roleAssignment.role.id : existingUser.roleId;

  if (!roleAssignment) assertCanManageUser(currentUser, existingUser.roleRef || existingRoleKey);

  if (roleKeyOf(currentUser) === "hr" && existingRoleKey !== "employee") {
    throw new ApiError(403, "HR can manage employee accounts only.");
  }

  if (currentUser.id === existingUser.id && normalizeStatus(payload.status) === "SUSPENDED") {
    throw new ApiError(400, "You cannot suspend your own account.");
  }

  const nextEmail = payload.email ? normalizeEmail(payload.email) : existingUser.email;
  const nextStatus = payload.status ? normalizeStatus(payload.status) : existingUser.status;
  if (nextEmail !== existingUser.email) {
    const duplicateEmail = await prisma.user.findUnique({ select: { id: true }, where: { email: nextEmail } });
    if (duplicateEmail && duplicateEmail.id !== existingUser.id) {
      throw new ApiError(409, "Another workspace account already uses this email address.");
    }
  }
  await ensureActiveSuperAdminRemains(existingUser, nextRoleKey, nextStatus);
  await validateSystemFields({
    currentUser,
    systemKey: "users",
    values: {
      ...existingUser,
      ...payload,
      email: nextEmail,
      fullName: payload.fullName || existingUser.fullName,
      role: nextRole,
      ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
      status: nextStatus,
      ...(payload.weeklyCapacityHours !== undefined ? { weeklyCapacityHours: payload.weeklyCapacityHours } : {}),
    },
  });
  const firebaseUpdates = {};

  if (nextEmail !== existingUser.email) firebaseUpdates.email = nextEmail;
  if (payload.fullName && payload.fullName !== existingUser.fullName) firebaseUpdates.displayName = payload.fullName;
  if (payload.password) firebaseUpdates.password = payload.password;
  if (nextStatus !== existingUser.status) firebaseUpdates.disabled = nextStatus === "SUSPENDED";

  if (Object.keys(firebaseUpdates).length) {
    try {
      await firebaseAuth.updateUser(existingUser.firebaseUid, firebaseUpdates);
    } catch (error) {
      if (error instanceof ApiError) throw error;

      throw new ApiError(400, mapFirebaseAdminError(error), error.code);
    }
  }

  const updatedUser = await prisma.user.update({
    data: {
      ...(payload.avatarUrl !== undefined ? { avatarUrl: payload.avatarUrl || null } : {}),
      contact: payload.contact ?? existingUser.contact,
      department: payload.department ?? existingUser.department,
      designation: payload.designation ?? existingUser.designation,
      email: nextEmail,
      fullName: payload.fullName || existingUser.fullName,
      role: nextRole,
      roleId: nextRoleId,
      ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
      status: nextStatus,
      ...(payload.weeklyCapacityHours !== undefined ? { weeklyCapacityHours: payload.weeklyCapacityHours } : {}),
      ...(payload.role && nextRoleKey !== existingRoleKey
        ? { customPermissions: [], usesCustomPermissions: false }
        : {}),
    },
    include: {
      organization: true,
      roleRef: true,
    },
    where: { id: existingUser.id },
  });

  await setFirebaseClaims({
    firebaseUid: updatedUser.firebaseUid,
    organizationId: updatedUser.organizationId,
    role: updatedUser.role,
  }).catch((error) => {
    console.warn("Unable to refresh Firebase claims for user:", error.message);
  });

  await safelyRecordAudit({
    action: nextStatus !== existingUser.status ? "STATUS_CHANGED" : "UPDATED",
    actor: currentUser,
    entityId: updatedUser.id,
    entityType: "USER",
    metadata: {
      fields: Object.keys(payload),
      role: toClientRole(updatedUser.role),
      status: String(updatedUser.status).toLowerCase(),
    },
    summary: `Updated account settings for ${updatedUser.fullName}`,
  });

  const customFields =
    payload.customFields === undefined
      ? existingCustomFields
      : await saveSystemEntityData({
          currentUser,
          entityId: updatedUser.id,
          existingValues: existingCustomFields,
          preparedData: preparedCustomFields,
          systemKey: "users",
          values: payload.customFields,
        });
  return { ...serializeUser(updatedUser), customFields };
};

const updateUserRole = async (currentUser, userId, role) => updateOrganizationUser(currentUser, userId, { role });

const getWorkspacePermissionCatalog = (currentUser) => {
  if (!hasPermission(currentUser, PERMISSIONS.USERS_VIEW)) {
    throw new ApiError(403, "You do not have permission to view workspace access settings.");
  }

  return getPermissionCatalog();
};

const updateUserPermissions = async (currentUser, userId, payload) => {
  if (!hasPermission(currentUser, PERMISSIONS.PERMISSIONS_MANAGE)) {
    throw new ApiError(403, "Only workspace administrators can customize permissions.");
  }

  if (!hasPermission(currentUser, PERMISSIONS.PERMISSIONS_MANAGE)) {
    throw new ApiError(403, "You do not have permission to customize account access.");
  }

  const existingUser = await getManagedUser(currentUser, userId);

  if (roleKeyOf(existingUser) === "super_admin" && roleKeyOf(currentUser) !== "super_admin") {
    throw new ApiError(403, "Only a super admin can change super admin permissions.");
  }

  if (existingUser.id === currentUser.id && !payload.useRoleDefaults) {
    throw new ApiError(400, "Use role defaults for your own account to avoid locking yourself out.");
  }

  const requestedPermissions = [...new Set(payload.permissions || [])];
  if (requestedPermissions.some((permission) => !isKnownPermission(permission))) {
    throw new ApiError(400, "One or more selected permissions are not supported.");
  }
  if (
    roleKeyOf(existingUser) !== "super_admin" &&
    requestedPermissions.includes(PERMISSIONS.CUSTOMIZATION_MANAGE)
  ) {
    throw new ApiError(400, "Module customization is reserved for super admin accounts.");
  }
  if (
    roleKeyOf(existingUser) === "super_admin" &&
    !payload.useRoleDefaults &&
    ![PERMISSIONS.USERS_MANAGE, PERMISSIONS.PERMISSIONS_MANAGE].every((permission) =>
      requestedPermissions.includes(permission),
    )
  ) {
    throw new ApiError(
      400,
      "A super admin custom policy must retain user and permission administration access.",
    );
  }

  const actorPermissions = resolvePermissions(currentUser);
  if (
    roleKeyOf(currentUser) !== "super_admin" &&
    requestedPermissions.some((permission) => !actorPermissions.includes(permission))
  ) {
    throw new ApiError(403, "You cannot grant a permission that your own account does not have.");
  }

  const updatedUser = await prisma.user.update({
    data: payload.useRoleDefaults
      ? { customPermissions: [], usesCustomPermissions: false }
      : { customPermissions: requestedPermissions, usesCustomPermissions: true },
    include: {
      organization: true,
      roleRef: true,
    },
    where: { id: existingUser.id },
  });

  await safelyRecordAudit({
    action: "PERMISSIONS_CHANGED",
    actor: currentUser,
    entityId: updatedUser.id,
    entityType: "USER",
    metadata: {
      permissionCount: payload.useRoleDefaults ? getRolePermissions(updatedUser.role).length : requestedPermissions.length,
      usesRoleDefaults: payload.useRoleDefaults,
    },
    summary: `Updated access policy for ${updatedUser.fullName}`,
  });

  return serializeUserWithCustomData(currentUser, updatedUser);
};

const deleteOrganizationUser = async (currentUser, userId) => {
  const existingUser = await getManagedUser(currentUser, userId);

  if (roleKeyOf(existingUser) === "super_admin" && roleKeyOf(currentUser) !== "super_admin") {
    throw new ApiError(403, "Only a super admin can suspend another super admin.");
  }

  assertCanManageUser(currentUser, existingUser.roleRef || roleKeyOf(existingUser));

  if (currentUser.id === existingUser.id) {
    throw new ApiError(400, "You cannot delete your own account.");
  }

  await ensureActiveSuperAdminRemains(existingUser, roleKeyOf(existingUser), "SUSPENDED");

  await firebaseAuth.updateUser(existingUser.firebaseUid, { disabled: true }).catch((error) => {
    console.warn("Unable to disable Firebase user:", error.message);
  });

  const updatedUser = await prisma.user.update({
    data: { status: "SUSPENDED" },
    include: {
      organization: true,
      roleRef: true,
    },
    where: { id: existingUser.id },
  });

  await safelyRecordAudit({
    action: "SUSPENDED",
    actor: currentUser,
    entityId: updatedUser.id,
    entityType: "USER",
    metadata: { previousStatus: String(existingUser.status).toLowerCase() },
    summary: `Suspended account for ${updatedUser.fullName}`,
  });

  return serializeUserWithCustomData(currentUser, updatedUser);
};

module.exports = {
  createOrganizationUser,
  deleteOrganizationUser,
  getCurrentUser,
  getWorkspacePermissionCatalog,
  getUserById,
  listEmployees,
  listUsers,
  serializeUser,
  syncUserProfile,
  updateCurrentProfile,
  updateOrganizationUser,
  updateUserPermissions,
  updateUserRole,
};
