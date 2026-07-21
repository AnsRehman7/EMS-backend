const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");

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

const createForRecipients = async ({ actor, notification, recipientIds }) => {
  const uniqueRecipients = [...new Set(recipientIds.filter((recipientId) => recipientId && recipientId !== actor.id))];
  if (!uniqueRecipients.length) return;

  await prisma.notification.createMany({
    data: uniqueRecipients.map((recipientId) => ({
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
      (!reassignedFromPrevious || administratorId !== priorAssigneeId),
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
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notifyProjectActivity,
  notifyTaskActivity,
  safelyNotify,
};
