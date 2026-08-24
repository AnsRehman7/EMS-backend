const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { firebaseAuth } = require("../config/firebaseAdmin");
const { roleKeyOf } = require("../utils/roles");
const { safelyRecordAudit } = require("./audit.service");

const normalizeDepartments = (departments = []) =>
  [...new Set(departments.map((department) => String(department).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );

const assertTimezone = (timezone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new ApiError(400, "Choose a valid IANA timezone, such as Asia/Karachi or America/New_York.");
  }
};

const serializeOrganization = (organization, inferredDepartments = []) => ({
  checkInGraceMinutes: organization.checkInGraceMinutes,
  checkoutWindowEnd: organization.checkoutWindowEnd,
  checkoutWindowStart: organization.checkoutWindowStart,
  createdAt: organization.createdAt,
  departments: normalizeDepartments([...(organization.departments || []), ...inferredDepartments]),
  holidays: [...new Set(organization.holidays || [])].sort(),
  id: organization.id,
  minimumOfficeMinutes: organization.minimumOfficeMinutes,
  name: organization.name,
  plan: String(organization.plan).toLowerCase(),
  slug: organization.slug,
  status: String(organization.status).toLowerCase(),
  timezone: organization.timezone,
  trialEndsAt: organization.trialEndsAt,
  updatedAt: organization.updatedAt,
  weekStartsOn: organization.weekStartsOn,
  workingDays: organization.workingDays?.length ? organization.workingDays : [1, 2, 3, 4, 5],
  workdayEnd: organization.workdayEnd,
  workdayStart: organization.workdayStart,
});

const serializeOffice = (office) => ({
  address: office.address || "",
  id: office.id,
  isActive: office.isActive,
  latitude: Number(office.latitude),
  longitude: Number(office.longitude),
  maxAccuracyMeters: office.maxAccuracyMeters,
  name: office.name,
  radiusMeters: office.radiusMeters,
  updatedAt: office.updatedAt,
});

const getWorkspaceSettings = async (currentUser) => {
  const [organization, users, projects, offices, usage] = await Promise.all([
    prisma.organization.findUnique({ where: { id: currentUser.organizationId } }),
    prisma.user.findMany({
      select: { department: true },
      where: { organizationId: currentUser.organizationId },
    }),
    prisma.project.findMany({
      select: { department: true },
      where: { organizationId: currentUser.organizationId },
    }),
    prisma.workspaceOffice.findMany({
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      where: { organizationId: currentUser.organizationId },
    }),
    Promise.all([
      prisma.user.count({ where: { organizationId: currentUser.organizationId, status: "ACTIVE" } }),
      prisma.project.count({ where: { organizationId: currentUser.organizationId, status: { not: "ARCHIVED" } } }),
      prisma.task.count({ where: { organizationId: currentUser.organizationId, status: { not: "COMPLETED" } } }),
    ]),
  ]);

  if (!organization) throw new ApiError(404, "Workspace not found.");

  const inferredDepartments = [...users, ...projects].map((item) => item.department).filter(Boolean);

  return {
    organization: serializeOrganization(organization, inferredDepartments),
    offices: offices.map(serializeOffice),
    usage: {
      activeMembers: usage[0],
      activeProjects: usage[1],
      openTasks: usage[2],
    },
  };
};

const createOffice = async (currentUser, payload) => {
  const office = await prisma.$transaction(async (transaction) => {
    const created = await transaction.workspaceOffice.create({
      data: { ...payload, organizationId: currentUser.organizationId },
    });
    await transaction.auditLog.create({
      data: {
        action: "CREATED",
        actorId: currentUser.id,
        entityId: created.id,
        entityType: "OFFICE",
        metadata: { latitude: payload.latitude, longitude: payload.longitude, radiusMeters: payload.radiusMeters },
        organizationId: currentUser.organizationId,
        summary: `Created attendance office: ${created.name}`,
      },
    });
    return created;
  });
  return serializeOffice(office);
};

const updateOffice = async (currentUser, officeId, payload) => {
  const existing = await prisma.workspaceOffice.findFirst({
    where: { id: officeId, organizationId: currentUser.organizationId },
  });
  if (!existing) throw new ApiError(404, "Office not found.");
  const office = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.workspaceOffice.update({ data: payload, where: { id: officeId } });
    await transaction.auditLog.create({
      data: {
        action: "UPDATED",
        actorId: currentUser.id,
        entityId: officeId,
        entityType: "OFFICE",
        metadata: { fields: Object.keys(payload) },
        organizationId: currentUser.organizationId,
        summary: `Updated attendance office: ${updated.name}`,
      },
    });
    return updated;
  });
  return serializeOffice(office);
};

const deleteOffice = async (currentUser, officeId) => {
  const existing = await prisma.workspaceOffice.findFirst({
    where: { id: officeId, organizationId: currentUser.organizationId },
  });
  if (!existing) throw new ApiError(404, "Office not found.");
  await prisma.$transaction([
    prisma.workspaceOffice.delete({ where: { id: officeId } }),
    prisma.auditLog.create({
      data: {
        action: "DELETED",
        actorId: currentUser.id,
        entityId: officeId,
        entityType: "OFFICE",
        organizationId: currentUser.organizationId,
        summary: `Deleted attendance office: ${existing.name}`,
      },
    }),
  ]);
};

const updateWorkspaceSettings = async (currentUser, payload) => {
  const existing = await prisma.organization.findUnique({ where: { id: currentUser.organizationId } });
  if (!existing) throw new ApiError(404, "Workspace not found.");

  const timezone = payload.timezone || existing.timezone;
  const workdayStart = payload.workdayStart || existing.workdayStart;
  const workdayEnd = payload.workdayEnd || existing.workdayEnd;
  const checkoutWindowStart = payload.checkoutWindowStart || existing.checkoutWindowStart;
  const checkoutWindowEnd = payload.checkoutWindowEnd || existing.checkoutWindowEnd;
  assertTimezone(timezone);

  // An end before the start is an overnight shift, which the attendance register
  // handles by attributing after-midnight scans back to the shift that started.
  if (workdayStart === workdayEnd) {
    throw new ApiError(400, "Workday start and end cannot be the same time.");
  }

  if (checkoutWindowStart === checkoutWindowEnd) {
    throw new ApiError(400, "The checkout window cannot start and end at the same time.");
  }

  const data = {
    ...(payload.checkInGraceMinutes !== undefined ? { checkInGraceMinutes: payload.checkInGraceMinutes } : {}),
    ...(payload.checkoutWindowEnd !== undefined ? { checkoutWindowEnd } : {}),
    ...(payload.checkoutWindowStart !== undefined ? { checkoutWindowStart } : {}),
    ...(payload.departments !== undefined ? { departments: normalizeDepartments(payload.departments) } : {}),
    ...(payload.minimumOfficeMinutes !== undefined ? { minimumOfficeMinutes: payload.minimumOfficeMinutes } : {}),
    ...(payload.holidays !== undefined ? { holidays: [...new Set(payload.holidays)].sort() } : {}),
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(payload.timezone !== undefined ? { timezone } : {}),
    ...(payload.weekStartsOn !== undefined ? { weekStartsOn: payload.weekStartsOn } : {}),
    ...(payload.workingDays !== undefined ? { workingDays: [...new Set(payload.workingDays)].sort() } : {}),
    ...(payload.workdayEnd !== undefined ? { workdayEnd } : {}),
    ...(payload.workdayStart !== undefined ? { workdayStart } : {}),
  };

  const organization = await prisma.organization.update({ data, where: { id: currentUser.organizationId } });

  await safelyRecordAudit({
    action: "UPDATED",
    actor: currentUser,
    entityId: organization.id,
    entityType: "WORKSPACE",
    metadata: { fields: Object.keys(data) },
    summary: `Updated workspace settings for ${organization.name}`,
  });

  return getWorkspaceSettings(currentUser);
};

/**
 * Permanently deletes a workspace and everything in it.
 *
 * Only User, Project, Task, and AttendanceScan hold `onDelete: Restrict` against the
 * organization, so those and their dependants are removed explicitly, deepest first.
 * Everything else cascades from the organization row. The whole thing runs in one
 * transaction: a partial delete would leave a workspace nobody can sign in to but
 * whose data still exists.
 */
const deleteWorkspace = async (currentUser, confirmation) => {
  if (roleKeyOf(currentUser) !== "super_admin") {
    throw new ApiError(403, "Only the workspace super admin can delete the workspace.");
  }

  const organization = await prisma.organization.findUnique({
    where: { id: currentUser.organizationId },
  });
  if (!organization) throw new ApiError(404, "Workspace not found.");

  // Typing the name is the last line of defence against an accidental click.
  if (String(confirmation || "").trim() !== organization.name) {
    throw new ApiError(400, "Type the workspace name exactly to confirm deletion.");
  }

  const members = await prisma.user.findMany({
    select: { email: true, firebaseUid: true },
    where: { organizationId: organization.id },
  });

  const organizationId = organization.id;
  const scope = { where: { organizationId } };

  await prisma.$transaction(async (transaction) => {
    // Children of the restricted models, deepest first.
    await transaction.customEntityData.deleteMany(scope);
    await transaction.customModuleRecord.deleteMany(scope);
    await transaction.customFieldDefinition.deleteMany(scope);
    await transaction.moduleDefinition.deleteMany(scope);

    await transaction.meetingAttendee.deleteMany(scope);
    await transaction.meeting.deleteMany(scope);

    await transaction.attendanceCorrection.deleteMany(scope);
    await transaction.attendanceChallenge.deleteMany(scope);
    await transaction.attendanceScan.deleteMany(scope);

    // Plans reference tasks, so they go before tasks do.
    await transaction.projectPlan.deleteMany(scope);
    await transaction.projectRequirement.deleteMany(scope);

    await transaction.taskAttachment.deleteMany(scope);
    await transaction.taskWatcher.deleteMany(scope);
    await transaction.timeLog.deleteMany(scope);
    await transaction.task.deleteMany(scope);
    await transaction.project.deleteMany(scope);

    await transaction.notification.deleteMany(scope);
    await transaction.pushSubscription.deleteMany(scope);
    await transaction.outboxEvent.deleteMany(scope);
    await transaction.auditLog.deleteMany(scope);

    await transaction.user.deleteMany(scope);
    await transaction.role.deleteMany(scope);
    await transaction.workspaceOffice.deleteMany(scope);

    await transaction.organization.delete({ where: { id: organizationId } });
  });

  // Firebase is cleaned up only after the database commits. Doing it first would strip
  // logins from a workspace that still exists if the transaction then failed.
  await Promise.all(
    members
      .filter((member) => !member.firebaseUid.startsWith("released:"))
      .map((member) =>
        firebaseAuth.deleteUser(member.firebaseUid).catch((error) => {
          console.warn(`Unable to delete the Firebase login for ${member.email}:`, error.message);
        }),
      ),
  );

  return { deletedMembers: members.length, name: organization.name };
};

module.exports = {
  createOffice,
  deleteOffice,
  deleteWorkspace,
  getWorkspaceSettings,
  updateOffice,
  updateWorkspaceSettings,
};
