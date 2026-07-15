const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { firebaseAuth } = require("../config/firebaseAdmin");
const {
  canAssignRole,
  canManageBilling,
  canManageUsers,
  canManageWork,
  canViewOrganizationWork,
  normalizeRole,
  toClientRole,
  USER_ROLES,
} = require("../utils/roles");

const normalizeEmail = (email = "") => email.trim().toLowerCase();
const normalizeStatus = (status = "active") => String(status || "active").trim().toUpperCase();

const serializeUser = (user) => ({
  contact: user.contact || "",
  department: user.department || "",
  designation: user.designation || "",
  email: user.email,
  id: user.id,
  name: user.fullName,
  organization: user.organization
    ? {
        id: user.organization.id,
        name: user.organization.name,
        plan: String(user.organization.plan).toLowerCase(),
        slug: user.organization.slug,
        status: String(user.organization.status).toLowerCase(),
        trialEndsAt: user.organization.trialEndsAt,
      }
    : null,
  organizationId: user.organizationId,
  permissions: {
    canManageBilling: canManageBilling(user),
    canManageUsers: canManageUsers(user),
    canManageWork: canManageWork(user),
    canViewOrganizationWork: canViewOrganizationWork(user),
  },
  role: toClientRole(user.role),
  status: String(user.status || "ACTIVE").toLowerCase(),
  uid: user.firebaseUid,
});

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

const mapFirebaseAdminError = (error) => {
  const messages = {
    EMAIL_EXISTS: "A Firebase login already exists for this email.",
    INVALID_EMAIL: "Enter a valid email address.",
    OPERATION_NOT_ALLOWED: "Enable Email/Password sign-in in Firebase Authentication.",
    WEAK_PASSWORD: "Password must be at least 6 characters.",
    "auth/email-already-exists": "A Firebase login already exists for this email.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/invalid-password": "Password must be at least 6 characters.",
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

  const existingUser = await prisma.user.findUnique({
    include: {
      organization: true,
    },
    where: { firebaseUid },
  });

  if (existingUser) {
    const updatedUser = await prisma.user.update({
      data: {
        contact: payload.contact ?? existingUser.contact,
        department: payload.department ?? existingUser.department,
        designation: payload.designation ?? existingUser.designation,
        email,
        fullName: payload.fullName || existingUser.fullName,
      },
      include: {
        organization: true,
      },
      where: { firebaseUid },
    });

    return serializeUser(updatedUser);
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
      },
      include: {
        organization: true,
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

  return serializeUser(createdUser);
};

const getCurrentUser = (user) => serializeUser(user);

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
    },
  });

  return employees.map(serializeUser);
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
    },
  });

  return users.map(serializeUser);
};

const assertCanManageUser = (actor, targetRole) => {
  if (!canManageUsers(actor)) {
    throw new ApiError(403, "You do not have permission to manage users.");
  }

  if (!canAssignRole(actor, targetRole)) {
    throw new ApiError(403, "You cannot assign that role.");
  }
};

const createOrganizationUser = async (currentUser, payload) => {
  ensureOrganization(currentUser);
  const role = normalizeRole(payload.role);
  assertCanManageUser(currentUser, role);

  const email = normalizeEmail(payload.email);
  let firebaseUser;

  try {
    firebaseUser = await firebaseAuth.createUser({
      disabled: false,
      displayName: payload.fullName,
      email,
      emailVerified: false,
      password: payload.password,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;

    throw new ApiError(400, mapFirebaseAdminError(error), error.code);
  }

  try {
    const user = await prisma.user.create({
      data: {
        contact: payload.contact || "",
        department: payload.department || "",
        designation: payload.designation || "",
        email,
        firebaseUid: firebaseUser.uid,
        fullName: payload.fullName,
        invitedById: currentUser.id,
        organizationId: currentUser.organizationId,
        role,
      },
      include: {
        organization: true,
      },
    });

    await setFirebaseClaims({
      firebaseUid: user.firebaseUid,
      organizationId: user.organizationId,
      role: user.role,
    }).catch((error) => {
      console.warn("Unable to set Firebase claims for managed user:", error.message);
    });

    return serializeUser(user);
  } catch (error) {
    await firebaseAuth.deleteUser(firebaseUser.uid).catch(() => {});
    throw error;
  }
};

const getManagedUser = async (currentUser, userId) => {
  ensureOrganization(currentUser);

  const user = await prisma.user.findFirst({
    include: {
      organization: true,
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

const updateOrganizationUser = async (currentUser, userId, payload) => {
  const existingUser = await getManagedUser(currentUser, userId);
  const nextRole = payload.role ? normalizeRole(payload.role) : existingUser.role;

  if (existingUser.role === USER_ROLES.SUPER_ADMIN && currentUser.role !== USER_ROLES.SUPER_ADMIN) {
    throw new ApiError(403, "Only a super admin can manage another super admin.");
  }

  assertCanManageUser(currentUser, nextRole);

  if (currentUser.role === USER_ROLES.HR && existingUser.role !== USER_ROLES.EMPLOYEE) {
    throw new ApiError(403, "HR can manage employee accounts only.");
  }

  if (currentUser.id === existingUser.id && normalizeStatus(payload.status) === "SUSPENDED") {
    throw new ApiError(400, "You cannot suspend your own account.");
  }

  const nextEmail = payload.email ? normalizeEmail(payload.email) : existingUser.email;
  const nextStatus = payload.status ? normalizeStatus(payload.status) : existingUser.status;
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
      contact: payload.contact ?? existingUser.contact,
      department: payload.department ?? existingUser.department,
      designation: payload.designation ?? existingUser.designation,
      email: nextEmail,
      fullName: payload.fullName || existingUser.fullName,
      role: nextRole,
      status: nextStatus,
    },
    include: {
      organization: true,
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

  return serializeUser(updatedUser);
};

const updateUserRole = async (currentUser, userId, role) => updateOrganizationUser(currentUser, userId, { role });

const deleteOrganizationUser = async (currentUser, userId) => {
  const existingUser = await getManagedUser(currentUser, userId);

  if (existingUser.role === USER_ROLES.SUPER_ADMIN && currentUser.role !== USER_ROLES.SUPER_ADMIN) {
    throw new ApiError(403, "Only a super admin can suspend another super admin.");
  }

  assertCanManageUser(currentUser, existingUser.role);

  if (currentUser.id === existingUser.id) {
    throw new ApiError(400, "You cannot delete your own account.");
  }

  await firebaseAuth.updateUser(existingUser.firebaseUid, { disabled: true }).catch((error) => {
    console.warn("Unable to disable Firebase user:", error.message);
  });

  const updatedUser = await prisma.user.update({
    data: { status: "SUSPENDED" },
    include: {
      organization: true,
    },
    where: { id: existingUser.id },
  });

  return serializeUser(updatedUser);
};

module.exports = {
  createOrganizationUser,
  deleteOrganizationUser,
  getCurrentUser,
  listEmployees,
  listUsers,
  serializeUser,
  syncUserProfile,
  updateOrganizationUser,
  updateUserRole,
};
