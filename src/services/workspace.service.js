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
  id: organization.id,
  name: organization.name,
  plan: String(organization.plan).toLowerCase(),
  slug: organization.slug,
  status: String(organization.status).toLowerCase(),
  timezone: organization.timezone,
  trialEndsAt: organization.trialEndsAt,
  updatedAt: organization.updatedAt,
  weekStartsOn: organization.weekStartsOn,
  workdayEnd: organization.workdayEnd,
  workdayStart: organization.workdayStart,
});

const getWorkspaceSettings = async (currentUser) => {
  const [organization, users, projects, usage] = await Promise.all([
    prisma.organization.findUnique({ where: { id: currentUser.organizationId } }),
    prisma.user.findMany({
      select: { department: true },
      where: { organizationId: currentUser.organizationId },
    }),
    prisma.project.findMany({
      select: { department: true },
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
    usage: {
      activeMembers: usage[0],
      activeProjects: usage[1],
      openTasks: usage[2],
    },
  };
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
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(payload.timezone !== undefined ? { timezone } : {}),
    ...(payload.weekStartsOn !== undefined ? { weekStartsOn: payload.weekStartsOn } : {}),
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
  getWorkspaceSettings,
  updateWorkspaceSettings,
};
