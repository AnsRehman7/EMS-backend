const prisma = require("../db/prisma");

const toClientAction = (value = "") => String(value).trim().toLowerCase();

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

module.exports = {
  listAuditLogs,
  recordAuditEvent,
  safelyRecordAudit,
  serializeAuditLog,
};
