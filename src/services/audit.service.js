const prisma = require("../db/prisma");

const toClientAction = (value = "") => String(value).trim().toLowerCase();

const normalizeAuditValue = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeAuditValue);
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber();
  return value;
};

const buildChangeSet = (before, after, fields) =>
  fields.flatMap(({ field, label, read = (record) => record?.[field] }) => {
    const from = normalizeAuditValue(read(before));
    const to = normalizeAuditValue(read(after));
    return JSON.stringify(from) === JSON.stringify(to) ? [] : [{ field, from, label, to }];
  });

const serializeAuditLog = (entry) => ({
  action: toClientAction(entry.action),
  actor: entry.actor
    ? {
        id: entry.actor.id,
        name: entry.actor.fullName,
        role: String(entry.actor.role).toLowerCase(),
      }
    : null,
  createdAt: entry.createdAt,
  entityId: entry.entityId || "",
  entityType: String(entry.entityType || "workspace").toLowerCase(),
  id: entry.id,
  metadata: entry.metadata || {},
  summary: entry.summary,
});

const recordAuditEvent = async ({ action, actor, entityId, entityType, metadata, summary }) => {
  if (!actor?.organizationId || !action || !entityType || !summary) return null;

  return prisma.auditLog.create({
    data: {
      action: String(action).trim().toUpperCase(),
      actorId: actor.id || null,
      entityId: entityId || null,
      entityType: String(entityType).trim().toUpperCase(),
      metadata: metadata || undefined,
      organizationId: actor.organizationId,
      summary: String(summary).trim().slice(0, 500),
    },
  });
};

const safelyRecordAudit = async (event) => {
  try {
    return await recordAuditEvent(event);
  } catch (error) {
    console.warn("Unable to record audit event:", error.message);
    return null;
  }
};

const listAuditLogs = async (currentUser, filters = {}) => {
  const take = Math.max(1, Math.min(Number(filters.limit) || 75, 200));
  const action = filters.action ? String(filters.action).trim().toUpperCase() : undefined;
  const entityType = filters.entityType ? String(filters.entityType).trim().toUpperCase() : undefined;

  const entries = await prisma.auditLog.findMany({
    include: {
      actor: {
        select: {
          fullName: true,
          id: true,
          role: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take,
    where: {
      organizationId: currentUser.organizationId,
      ...(action ? { action } : {}),
      ...(entityType ? { entityType } : {}),
    },
  });

  return entries.map(serializeAuditLog);
};

const listEntityActivity = async (currentUser, entityType, entityId, limit = 100) => {
  const entries = await prisma.auditLog.findMany({
    include: {
      actor: {
        select: {
          fullName: true,
          id: true,
          role: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(Number(limit) || 100, 200)),
    where: {
      entityId,
      entityType: String(entityType).trim().toUpperCase(),
      organizationId: currentUser.organizationId,
    },
  });

  return entries.map(serializeAuditLog);
};

module.exports = {
  buildChangeSet,
  listAuditLogs,
  listEntityActivity,
  recordAuditEvent,
  safelyRecordAudit,
  serializeAuditLog,
};
