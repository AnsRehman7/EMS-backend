const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
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
  createdAt: organization.createdAt,
  departments: normalizeDepartments([...(organization.departments || []), ...inferredDepartments]),
  holidays: [...new Set(organization.holidays || [])].sort(),
  id: organization.id,
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
  assertTimezone(timezone);

  if (workdayStart >= workdayEnd) {
    throw new ApiError(400, "Workday end must be later than workday start.");
  }

  const data = {
    ...(payload.departments !== undefined ? { departments: normalizeDepartments(payload.departments) } : {}),
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

module.exports = {
  createOffice,
  deleteOffice,
  getWorkspaceSettings,
  updateOffice,
  updateWorkspaceSettings,
};
