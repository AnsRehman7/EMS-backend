const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { canManageWork, canViewOrganizationWork } = require("../utils/roles");
const { analyzeTaskProgress, refreshProjectWeights, updateProjectProgress } = require("./analysis.service");

const normalizePriority = (priority = "normal") => String(priority).trim().toUpperCase();
const normalizeStatus = (status = "open") => {
  const value = String(status).trim().toUpperCase();
  return value === "OPEN" ? "NEW" : value;
};
const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

const parseDate = (value, label) => {
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, `${label} must be a valid date.`);
  }

  return parsed;
};

const serializeTimeLog = (timeLog) => ({
  aiProgressAfter: timeLog.aiProgressAfter,
  analysisSummary: timeLog.analysisSummary || "",
  createdAt: timeLog.createdAt,
  hours: toNumber(timeLog.hours) || 0,
  id: timeLog.id,
  loggedAt: timeLog.loggedAt,
  note: timeLog.note || "",
  taskId: timeLog.taskId,
  userId: timeLog.userId,
  userName: timeLog.user?.fullName || "Team member",
});

const serializeTask = (task) => ({
  assignedToEmail: task.assignedTo?.email || "",
  assignedToId: task.assignedToId,
  assignedToName: task.assignedTo?.fullName || "Unassigned",
  category: task.category,
  completedAt: task.completedAt,
  createdAt: task.createdAt,
  createdByEmail: task.createdBy?.email || "",
  createdById: task.createdById,
  createdByName: task.createdBy?.fullName || "Manager",
  deadline: task.deadline ? task.deadline.toISOString().slice(0, 10) : "",
  description: task.description,
  estimatedHours: toNumber(task.estimatedHours),
  id: task.id,
  aiAnalyzedAt: task.aiAnalyzedAt,
  aiProgress: String(task.status) === "COMPLETED" ? 100 : task.aiProgress || 0,
  aiSummary: task.aiSummary || "",
  priority: String(task.priority).toLowerCase(),
  projectId: task.projectId || "",
  projectName: task.project?.name || "Unassigned project",
  projectWeight: toNumber(task.projectWeight) || 0,
  status: String(task.status) === "NEW" ? "open" : String(task.status).toLowerCase(),
  successCriteria: task.successCriteria || "",
  timeLogs: (task.timeLogs || []).map(serializeTimeLog),
  title: task.title,
  totalLoggedHours: (task.timeLogs || []).reduce((total, timeLog) => total + (toNumber(timeLog.hours) || 0), 0),
  updatedAt: task.updatedAt,
});

const taskInclude = {
  assignedTo: true,
  createdBy: true,
  project: true,
  timeLogs: {
    include: {
      user: true,
    },
    orderBy: {
      loggedAt: "desc",
    },
  },
};

const listTasks = async (currentUser) => {
  const organizationWhere = { organizationId: currentUser.organizationId };
  const tasks = await prisma.task.findMany({
    include: taskInclude,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    where: canViewOrganizationWork(currentUser)
      ? organizationWhere
      : { ...organizationWhere, assignedToId: currentUser.id },
  });

  return tasks.map(serializeTask);
};

const createTask = async (currentUser, payload) => {
  if (!canManageWork(currentUser)) {
    throw new ApiError(403, "You do not have permission to assign tasks.");
  }

  const assignee = await prisma.user.findFirst({
    where: {
      id: payload.assignedToId,
      organizationId: currentUser.organizationId,
      status: "ACTIVE",
    },
  });

  if (!assignee) {
    throw new ApiError(400, "Choose a valid active team member.");
  }

  const project = await prisma.project.findFirst({
    where: {
      id: payload.projectId,
      organizationId: currentUser.organizationId,
    },
  });

  if (!project) {
    throw new ApiError(400, "Choose a valid project before assigning the task.");
  }

  if (project.status === "ARCHIVED") {
    throw new ApiError(400, "Archived projects cannot receive new tasks.");
  }

  const task = await prisma.task.create({
    data: {
      assignedToId: assignee.id,
      category: payload.category,
      createdById: currentUser.id,
      deadline: parseDate(payload.deadline, "Deadline"),
      description: payload.description,
      estimatedHours: payload.estimatedHours ?? null,
      organizationId: currentUser.organizationId,
      priority: normalizePriority(payload.priority),
      projectId: payload.projectId,
      successCriteria: payload.successCriteria || null,
      status: normalizeStatus(payload.status),
      title: payload.title,
    },
    include: taskInclude,
  });

  await refreshProjectWeights(project.id, currentUser.organizationId);

  const analyzedTask = await prisma.task.findUnique({
    include: taskInclude,
    where: { id: task.id },
  });

  return serializeTask(analyzedTask);
};

const getTaskForAction = async (taskId, currentUser) => {
  const task = await prisma.task.findFirst({
    include: taskInclude,
    where: {
      id: taskId,
      organizationId: currentUser.organizationId,
    },
  });

  if (!task) {
    throw new ApiError(404, "Task not found.");
  }

  if (!canManageWork(currentUser) && task.assignedToId !== currentUser.id) {
    throw new ApiError(403, "You can only update tasks assigned to you.");
  }

  return task;
};

const getTaskById = async (taskId, currentUser) => {
  const task = await prisma.task.findFirst({
    include: taskInclude,
    where: {
      id: taskId,
      organizationId: currentUser.organizationId,
    },
  });

  if (!task) {
    throw new ApiError(404, "Task not found.");
  }

  if (!canViewOrganizationWork(currentUser) && task.assignedToId !== currentUser.id) {
    throw new ApiError(403, "You can only view tasks assigned to you.");
  }

  return serializeTask(task);
};

const updateTask = async (taskId, currentUser, payload) => {
  if (!canManageWork(currentUser)) {
    throw new ApiError(403, "You do not have permission to edit tasks.");
  }

  const existingTask = await getTaskForAction(taskId, currentUser);
  const data = {};

  if (payload.assignedToId !== undefined) {
    if (payload.assignedToId === null) {
      data.assignedToId = null;
    } else {
      const assignee = await prisma.user.findFirst({
        where: {
          id: payload.assignedToId,
          organizationId: currentUser.organizationId,
          status: "ACTIVE",
        },
      });

      if (!assignee) throw new ApiError(400, "Choose a valid active team member.");
      data.assignedToId = assignee.id;
    }
  }

  if (payload.projectId !== undefined) {
    const project = await prisma.project.findFirst({
      where: {
        id: payload.projectId,
        organizationId: currentUser.organizationId,
      },
    });

    if (!project || project.status === "ARCHIVED") {
      throw new ApiError(400, "Choose a valid non-archived project.");
    }
    data.projectId = project.id;
  }

  if (payload.category !== undefined) data.category = payload.category;
  if (payload.deadline !== undefined) data.deadline = parseDate(payload.deadline, "Deadline");
  if (payload.description !== undefined) data.description = payload.description;
  if (payload.estimatedHours !== undefined) data.estimatedHours = payload.estimatedHours;
  if (payload.priority !== undefined) data.priority = normalizePriority(payload.priority);
  if (payload.successCriteria !== undefined) data.successCriteria = payload.successCriteria || null;
  if (payload.title !== undefined) data.title = payload.title;

  if (payload.status !== undefined) {
    const status = normalizeStatus(payload.status);
    data.status = status;
    data.aiAnalyzedAt = new Date();
    data.aiProgress = status === "COMPLETED" ? 100 : Math.min(existingTask.aiProgress || 0, 95);
    data.completedAt = status === "COMPLETED" ? new Date() : null;
  }

  await prisma.task.update({ data, where: { id: taskId } });

  const nextProjectId = data.projectId || existingTask.projectId;
  if (data.projectId && data.projectId !== existingTask.projectId) {
    await refreshProjectWeights(existingTask.projectId, currentUser.organizationId);
    await refreshProjectWeights(data.projectId, currentUser.organizationId);
  } else if (payload.status !== undefined) {
    await updateProjectProgress(nextProjectId, currentUser.organizationId);
  }

  const updatedTask = await prisma.task.findUnique({ include: taskInclude, where: { id: taskId } });
  return serializeTask(updatedTask);
};

const updateTaskStatus = async (taskId, status, currentUser) => {
  const existingTask = await getTaskForAction(taskId, currentUser);

  const normalizedStatus = normalizeStatus(status);
  const task = await prisma.task.update({
    data: {
      aiAnalyzedAt: new Date(),
      aiProgress: normalizedStatus === "COMPLETED" ? 100 : Math.min(existingTask.aiProgress || 0, 95),
      completedAt: normalizedStatus === "COMPLETED" ? new Date() : null,
      status: normalizedStatus,
    },
    include: taskInclude,
    where: { id: taskId },
  });

  await updateProjectProgress(task.projectId, currentUser.organizationId);

  return serializeTask(task);
};

const createTimeLog = async (taskId, currentUser, payload) => {
  await getTaskForAction(taskId, currentUser);

  const timeLog = await prisma.timeLog.create({
    data: {
      hours: payload.hours,
      loggedAt: parseDate(payload.loggedAt, "Logged date") || new Date(),
      note: payload.note || null,
      taskId,
      userId: currentUser.id,
    },
    include: {
      user: true,
    },
  });

  await analyzeTaskProgress({
    latestComment: payload.note || "",
    organizationId: currentUser.organizationId,
    taskId,
    timeLogId: timeLog.id,
  });

  const analyzedTimeLog = await prisma.timeLog.findUnique({
    include: {
      user: true,
    },
    where: { id: timeLog.id },
  });

  return serializeTimeLog(analyzedTimeLog);
};

const deleteTask = async (taskId, currentUser) => {
  if (!canManageWork(currentUser)) {
    throw new ApiError(403, "You do not have permission to delete tasks.");
  }

  const task = await getTaskForAction(taskId, currentUser);
  await prisma.task.delete({ where: { id: taskId } });
  await refreshProjectWeights(task.projectId, currentUser.organizationId);
};

const getTaskStats = async (currentUser) => {
  const organizationWhere = { organizationId: currentUser.organizationId };
  const where = canViewOrganizationWork(currentUser)
    ? organizationWhere
    : { ...organizationWhere, assignedToId: currentUser.id };
  const [total, completed, active] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.count({ where: { ...where, status: "COMPLETED" } }),
    prisma.task.count({ where: { ...where, status: { not: "COMPLETED" } } }),
  ]);

  return { active, completed, total };
};

module.exports = {
  createTimeLog,
  createTask,
  deleteTask,
  getTaskById,
  getTaskStats,
  listTasks,
  serializeTask,
  taskInclude,
  updateTask,
  updateTaskStatus,
};
