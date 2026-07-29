const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { firebaseMessaging } = require("../config/firebaseAdmin");
const { env } = require("../config/env");

const serializeNotification = (notification) => ({
  actionUrl: notification.actionUrl || "",
  actorId: notification.actorId || "",
  actorName: notification.actor?.fullName || "StaffFlow",
  createdAt: notification.createdAt,
  entityId: notification.entityId || "",
  entityType: notification.entityType || "",
  id: notification.id,
  isRead: Boolean(notification.readAt),
  message: notification.message,
  readAt: notification.readAt,
  title: notification.title,
  type: notification.type,
});

const notificationInclude = {
  actor: {
    select: {
      fullName: true,
    },
  },
};

const listNotifications = async (currentUser) => {
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      include: notificationInclude,
      orderBy: { createdAt: "desc" },
      take: 40,
      where: {
        organizationId: currentUser.organizationId,
        recipientId: currentUser.id,
      },
    }),
    prisma.notification.count({
      where: {
        organizationId: currentUser.organizationId,
        readAt: null,
        recipientId: currentUser.id,
      },
    }),
  ]);

  return { notifications: notifications.map(serializeNotification), unreadCount };
};

const markNotificationRead = async (currentUser, notificationId) => {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      organizationId: currentUser.organizationId,
      recipientId: currentUser.id,
    },
  });

  if (!notification) throw new ApiError(404, "Notification not found.");

  const updatedNotification = await prisma.notification.update({
    data: { readAt: notification.readAt || new Date() },
    include: notificationInclude,
    where: { id: notification.id },
  });

  return serializeNotification(updatedNotification);
};

const markAllNotificationsRead = async (currentUser) => {
  await prisma.notification.updateMany({
    data: { readAt: new Date() },
    where: {
      organizationId: currentUser.organizationId,
      readAt: null,
      recipientId: currentUser.id,
    },
  });
};

const dispatchPush = async (recipientIds, notification, organizationId = undefined) => {
  if (!firebaseMessaging || !recipientIds.length) return { delivered: 0 };
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { active: true, ...(organizationId ? { organizationId } : {}), userId: { in: recipientIds } },
  });
  if (!subscriptions.length) return { delivered: 0 };
  const appOrigin = env.corsOrigins.find((origin) => origin.startsWith("https://"));
  const actionUrl = notification.actionUrl || "/";
  const result = await firebaseMessaging.sendEachForMulticast({
    data: {
      actionUrl,
      entityId: String(notification.entityId || ""),
      entityType: String(notification.entityType || ""),
      eventId: String(notification.eventId || ""),
      message: String(notification.message || ""),
      title: String(notification.title || "StaffFlow"),
      type: String(notification.type || "GENERAL"),
    },
    notification: { body: notification.message, title: notification.title },
    tokens: subscriptions.map((subscription) => subscription.token),
    ...(appOrigin ? { webpush: { fcmOptions: { link: new URL(actionUrl, appOrigin).toString() } } } : {}),
  });
  const invalidTokenCodes = new Set([
    "messaging/invalid-registration-token",
    "messaging/registration-token-not-registered",
  ]);
  const invalidIds = result.responses.flatMap((response, index) =>
    !response.success && invalidTokenCodes.has(response.error?.code) ? [subscriptions[index].id] : [],
  );
  if (invalidIds.length) {
    await prisma.pushSubscription.updateMany({ data: { active: false }, where: { id: { in: invalidIds } } });
  }
  return { delivered: result.successCount, failed: result.failureCount };
};

const deliverOutboxEvent = async (eventId) => {
  const now = new Date();
  const claimed = await prisma.outboxEvent.updateMany({
    data: { attempts: { increment: 1 }, lastError: null, status: "PROCESSING" },
    where: {
      availableAt: { lte: now },
      id: eventId,
      status: { in: ["PENDING", "FAILED"] },
    },
  });
  if (claimed.count !== 1) return { claimed: false };

  const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } });
  if (!event) return { claimed: false };

  try {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const recipientIds = Array.isArray(payload.recipientIds) ? payload.recipientIds : [];
    const push = payload.push && typeof payload.push === "object" ? payload.push : null;
    const result = push && recipientIds.length
      ? await dispatchPush(recipientIds, { ...push, eventId: event.id }, event.organizationId)
      : { delivered: 0, failed: 0 };
    await prisma.outboxEvent.update({
      data: { lastError: null, processedAt: new Date(), status: "DELIVERED" },
      where: { id: event.id },
    });
    return { claimed: true, ...result };
  } catch (error) {
    const retrySeconds = Math.min(3600, 5 * (2 ** Math.min(event.attempts, 8)));
    await prisma.outboxEvent.update({
      data: {
        availableAt: new Date(Date.now() + retrySeconds * 1000),
        lastError: String(error.message || error).slice(0, 2000),
        status: "FAILED",
      },
      where: { id: event.id },
    });
    throw error;
  }
};

const safelyDeliverOutboxEvent = async (eventId) => {
  try {
    return await deliverOutboxEvent(eventId);
  } catch (error) {
    console.warn(`[outbox] Delivery ${eventId} failed:`, error.message);
    return { claimed: true, delivered: 0, failed: 1 };
  }
};

const processOutboxEvents = async ({ limit = env.outboxBatchSize } = {}) => {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  await prisma.outboxEvent.updateMany({
    data: { availableAt: new Date(), lastError: "Recovered stale processing claim.", status: "FAILED" },
    where: { status: "PROCESSING", updatedAt: { lt: staleBefore } },
  });
  const events = await prisma.outboxEvent.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: Math.max(1, Math.min(Number(limit) || 25, 100)),
    where: { attempts: { lt: 10 }, availableAt: { lte: new Date() }, status: { in: ["PENDING", "FAILED"] } },
  });
  let delivered = 0;
  let failed = 0;
  for (const event of events) {
    const result = await safelyDeliverOutboxEvent(event.id);
    if (result?.failed) failed += 1;
    else if (result?.claimed) delivered += 1;
  }
  return { delivered, failed, inspected: events.length };
};

const registerPushSubscription = async (currentUser, payload) => {
  const subscription = await prisma.pushSubscription.upsert({
    create: {
      deviceName: payload.deviceName || null,
      organizationId: currentUser.organizationId,
      platform: String(payload.platform).toUpperCase(),
      token: payload.token,
      userId: currentUser.id,
    },
    update: {
      active: true,
      deviceName: payload.deviceName || null,
      lastSeenAt: new Date(),
      organizationId: currentUser.organizationId,
      platform: String(payload.platform).toUpperCase(),
      userId: currentUser.id,
    },
    where: { token: payload.token },
  });
  return { id: subscription.id, platform: String(subscription.platform).toLowerCase() };
};

const unregisterPushSubscription = async (currentUser, token) => {
  await prisma.pushSubscription.updateMany({
    data: { active: false },
    where: { token, userId: currentUser.id },
  });
};

const createForRecipients = async ({ actor, notification, recipientIds }) => {
  const uniqueRecipients = [...new Set(recipientIds.filter((recipientId) => recipientId && recipientId !== actor.id))];
  if (!uniqueRecipients.length) return;

  const event = await prisma.$transaction(async (transaction) => {
    const verifiedRecipients = await transaction.user.findMany({
      select: { id: true },
      where: {
        id: { in: uniqueRecipients },
        organizationId: actor.organizationId,
        status: "ACTIVE",
      },
    });
    const recipientIdsForOrganization = verifiedRecipients.map(({ id }) => id);
    if (!recipientIdsForOrganization.length) return null;
    await transaction.notification.createMany({
      data: recipientIdsForOrganization.map((recipientId) => ({
        actionUrl: notification.actionUrl || null,
        actorId: actor.id,
        entityId: notification.entityId || null,
        entityType: notification.entityType || null,
        message: notification.message,
        organizationId: actor.organizationId,
        recipientId,
        title: notification.title,
        type: notification.type,
      })),
    });
    return transaction.outboxEvent.create({
      data: {
        aggregateId: notification.entityId || actor.id,
        aggregateType: String(notification.entityType || "NOTIFICATION").toUpperCase(),
        organizationId: actor.organizationId,
        payload: {
          push: {
            actionUrl: notification.actionUrl || "/",
            entityId: notification.entityId || "",
            entityType: notification.entityType || "",
            message: notification.message,
            title: notification.title,
            type: notification.type,
          },
          recipientIds: recipientIdsForOrganization,
        },
        topic: "notification.push",
      },
    });
  });
  if (event) await safelyDeliverOutboxEvent(event.id);
};

const getAdministratorIds = async (organizationId) => {
  const administrators = await prisma.user.findMany({
    select: { id: true },
    where: {
      organizationId,
      role: { in: ["SUPER_ADMIN", "ADMIN"] },
      status: "ACTIVE",
    },
  });

  return administrators.map(({ id }) => id);
};

const notifyTaskActivity = async ({ actor, event, previousAssigneeId, previousTask, task }) => {
  const priorAssigneeId = previousTask?.assignedToId ?? previousAssigneeId ?? null;
  const previousStatus = previousTask?.status ? String(previousTask.status).toUpperCase() : null;
  const currentStatus = String(task.status || "").toUpperCase();
  const justCompleted = currentStatus === "COMPLETED" && previousStatus !== "COMPLETED";
  const assigneeChanged = event !== "deleted" && task.assignedToId && task.assignedToId !== priorAssigneeId;

  if (assigneeChanged) {
    await createForRecipients({
      actor,
      notification: {
        actionUrl: `/tasks/${task.id}`,
        entityId: task.id,
        entityType: "task",
        message: `${actor.fullName} assigned "${task.title}" to you.`,
        title: "New task assigned",
        type: "TASK_ASSIGNED",
      },
      recipientIds: [task.assignedToId],
    });
  }

  if (event !== "deleted" && priorAssigneeId && priorAssigneeId !== task.assignedToId) {
    await createForRecipients({
      actor,
      notification: {
        actionUrl: `/tasks/${task.id}`,
        entityId: task.id,
        entityType: "task",
        message: `${actor.fullName} reassigned "${task.title}" to another team member.`,
        title: "Task reassigned",
        type: "TASK_UNASSIGNED",
      },
      recipientIds: [priorAssigneeId],
    });
  }

  const directAssigneeId =
    event === "deleted"
      ? priorAssigneeId
      : !assigneeChanged && event !== "created"
        ? task.assignedToId
        : null;

  if (directAssigneeId) {
    const directMessages = {
      deleted: `${actor.fullName} removed "${task.title}".`,
      time_logged: `${actor.fullName} added a work update to "${task.title}".`,
      updated: justCompleted
        ? `${actor.fullName} completed "${task.title}".`
        : `${actor.fullName} updated "${task.title}".`,
    };
    await createForRecipients({
      actor,
      notification: {
        actionUrl: event === "deleted" ? "/tasks" : `/tasks/${task.id}`,
        entityId: task.id,
        entityType: "task",
        message: directMessages[event] || `${actor.fullName} updated "${task.title}".`,
        title: justCompleted ? "Task completed" : event === "deleted" ? "Task removed" : "Task updated",
        type: justCompleted ? "TASK_COMPLETED" : event === "deleted" ? "TASK_DELETED" : "TASK_UPDATED",
      },
      recipientIds: [directAssigneeId],
    });
  }

  const adminIds = await getAdministratorIds(actor.organizationId);
  const eventLabels = {
    created: "created",
    deleted: "deleted",
    time_logged: "received a work update",
    updated: "was updated",
  };
  const eventLabel = justCompleted ? "was completed" : eventLabels[event] || "was updated";
  const reassignedFromPrevious = event !== "deleted" && priorAssigneeId && priorAssigneeId !== task.assignedToId;
  const activityRecipientIds = adminIds.filter(
    (administratorId) =>
      (!assigneeChanged || administratorId !== task.assignedToId) &&
      (!reassignedFromPrevious || administratorId !== priorAssigneeId) &&
      administratorId !== directAssigneeId,
  );

  await createForRecipients({
    actor,
    notification: {
      actionUrl: event === "deleted" ? "/tasks" : `/tasks/${task.id}`,
      entityId: task.id,
      entityType: "task",
      message: `${actor.fullName}: "${task.title}" ${eventLabel}.`,
      title: justCompleted ? "Task completed" : "Task activity",
      type: justCompleted ? "TASK_COMPLETED" : "TASK_UPDATED",
    },
    recipientIds: activityRecipientIds,
  });
};

const notifyProjectActivity = async ({ actor, event, previousProject, project }) => {
  const adminIds = await getAdministratorIds(actor.organizationId);
  const previousStatus = previousProject?.status ? String(previousProject.status).toUpperCase() : null;
  const currentStatus = String(project.status || "").toUpperCase();
  const justCompleted = currentStatus === "COMPLETED" && previousStatus !== "COMPLETED";
  const previousOwnerId = previousProject?.ownerId || null;
  const ownerChanged = event !== "deleted" && project.ownerId && project.ownerId !== previousOwnerId;
  const recipientIds = [
    ...adminIds.filter((administratorId) => !ownerChanged || administratorId !== project.ownerId),
    ...(!ownerChanged && project.ownerId ? [project.ownerId] : []),
  ];
  const eventLabels = {
    archived: "was archived",
    created: "was created",
    deleted: "was deleted",
    updated: "was updated",
  };
  const eventLabel = justCompleted ? "was completed" : eventLabels[event] || "was updated";

  await createForRecipients({
    actor,
    notification: {
      actionUrl: event === "deleted" ? "/projects" : `/projects/${project.id}`,
      entityId: project.id,
      entityType: "project",
      message: `${actor.fullName}: "${project.name}" ${eventLabel}.`,
      title: justCompleted ? "Project completed" : "Project activity",
      type: justCompleted ? "PROJECT_COMPLETED" : "PROJECT_UPDATED",
    },
    recipientIds,
  });

  if (ownerChanged) {
    await createForRecipients({
      actor,
      notification: {
        actionUrl: `/projects/${project.id}`,
        entityId: project.id,
        entityType: "project",
        message: `${actor.fullName} made you the owner of "${project.name}".`,
        title: "Project ownership assigned",
        type: "PROJECT_OWNER_ASSIGNED",
      },
      recipientIds: [project.ownerId],
    });
  }

  if (event !== "deleted" && previousOwnerId && previousOwnerId !== project.ownerId) {
    await createForRecipients({
      actor,
      notification: {
        actionUrl: `/projects/${project.id}`,
        entityId: project.id,
        entityType: "project",
        message: `${actor.fullName} assigned a new owner to "${project.name}".`,
        title: "Project ownership updated",
        type: "PROJECT_OWNER_REMOVED",
      },
      recipientIds: [previousOwnerId],
    });
  }
};

const safelyNotify = async (callback) => {
  try {
    await callback();
  } catch (error) {
    console.warn("[notifications] Unable to create notification:", error.message);
  }
};

module.exports = {
  createForRecipients,
  dispatchPush,
  deliverOutboxEvent,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notifyProjectActivity,
  notifyTaskActivity,
  processOutboxEvents,
  registerPushSubscription,
  safelyNotify,
  safelyDeliverOutboxEvent,
  unregisterPushSubscription,
};
