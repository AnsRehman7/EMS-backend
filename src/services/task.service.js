const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { hasPermission, PERMISSIONS } = require("../utils/permissions");
const { analyzeTaskProgress, refreshProjectWeights, updateProjectProgress } = require("./analysis.service");
const { notifyTaskActivity, safelyDeliverOutboxEvent, safelyNotify } = require("./notification.service");
const { buildChangeSet, listEntityActivity, safelyRecordAudit } = require("./audit.service");
const {
  attachSystemCustomData,
  getSystemEntityData,
  saveSystemEntityData,
  validateSystemCustomValues,
  validateSystemFields,
} = require("./module.service");

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
  confidence: task.confidence ?? null,
  completedAt: task.completedAt,
  createdAt: task.createdAt,
  createdByEmail: task.createdBy?.email || "",
  createdById: task.createdById,
  createdByName: task.createdBy?.fullName || "Manager",
  deadline: task.deadline ? task.deadline.toISOString().slice(0, 10) : "",
  description: task.description,
  dependencyCount: task._count?.dependencies ?? task.dependencies?.length ?? 0,
  dependencyIds: (task.dependencies || []).map((dependency) => dependency.dependsOnTaskId),
  dependencies: (task.dependencies || []).map((dependency) => ({
    id: dependency.dependsOnTaskId,
    status: dependency.dependsOn ? String(dependency.dependsOn.status).toLowerCase() : "",
    title: dependency.dependsOn?.title || "Dependency",
  })),
  estimatedHours: toNumber(task.estimatedHours),
  id: task.id,
  aiAnalyzedAt: task.aiAnalyzedAt,
  aiProgress: String(task.status) === "COMPLETED" ? 100 : task.aiProgress || 0,
  aiSummary: task.aiSummary || "",
  priority: String(task.priority).toLowerCase(),
  projectId: task.projectId || "",
  projectName: task.project?.name || "Unassigned project",
  projectWeight: toNumber(task.projectWeight) || 0,
  requiredSkills: task.requiredSkills || [],
  riskLevel: String(task.riskLevel || "LOW").toLowerCase(),
  source: task.source || "manual",
  status: String(task.status) === "NEW" ? "open" : String(task.status).toLowerCase(),
  successCriteria: task.successCriteria || "",
  timeLogs: (task.timeLogs || []).map(serializeTimeLog),
  title: task.title,
  totalLoggedHours: (task.timeLogs || []).reduce((total, timeLog) => total + (toNumber(timeLog.hours) || 0), 0),
  updatedAt: task.updatedAt,
  version: task.version || 1,
  watcherIds: (task.watchers || []).map((watcher) => watcher.userId),
});

const taskInclude = {
  assignedTo: true,
  createdBy: true,
  project: true,
  dependencies: {
    include: {
      dependsOn: { select: { id: true, status: true, title: true } },
    },
  },
  watchers: { select: { userId: true } },
  timeLogs: {
    include: {
      user: true,
    },
    orderBy: {
      loggedAt: "desc",
    },
  },
};

const taskChangeFields = [
  { field: "title", label: "Title" },
  { field: "description", label: "Description" },
  { field: "successCriteria", label: "Success criteria" },
  { field: "category", label: "Category" },
  { field: "priority", label: "Priority" },
  { field: "status", label: "Status" },
  {
    field: "deadline",
    label: "Due date",
    read: (record) => record?.deadline?.toISOString().slice(0, 10) || null,
  },
  { field: "estimatedHours", label: "Estimated hours" },
  {
    field: "assignedToId",
    label: "Assignee",
    read: (record) => record?.assignedTo?.fullName || null,
  },
  {
    field: "projectId",
    label: "Project",
    read: (record) => record?.project?.name || null,
  },
];

const validateDependencies = async (currentUser, dependencyIds = [], projectId, excludedTaskId) => {
  const ids = [...new Set(dependencyIds)].filter((id) => id && id !== excludedTaskId);
  if (!ids.length) return [];
  const dependencies = await prisma.task.findMany({
    select: { id: true },
    where: {
      deletedAt: null,
      id: { in: ids },
      organizationId: currentUser.organizationId,
      projectId,
    },
  });
  if (dependencies.length !== ids.length) {
    throw new ApiError(400, "Dependencies must be active tasks from the same project.");
  }
  return ids;
};

const dependencyGraphHasCycle = (edges) => {
  const graph = new Map();
  for (const { taskId, dependsOnTaskId } of edges) {
    if (!graph.has(taskId)) graph.set(taskId, []);
    graph.get(taskId).push(dependsOnTaskId);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId) => {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    for (const dependencyId of graph.get(taskId) || []) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  };
  return [...graph.keys()].some(visit);
};

const assertDependencyGraphAcyclic = async (currentUser, taskId, projectId, dependencyIds) => {
  const existingEdges = await prisma.taskDependency.findMany({
    select: { dependsOnTaskId: true, taskId: true },
    where: {
      task: {
        deletedAt: null,
        organizationId: currentUser.organizationId,
        projectId,
      },
    },
  });
  const proposedEdges = [
    ...existingEdges.filter((edge) => edge.taskId !== taskId),
    ...dependencyIds.map((dependsOnTaskId) => ({ dependsOnTaskId, taskId })),
  ];
  if (dependencyGraphHasCycle(proposedEdges)) {
    throw new ApiError(409, "These dependencies create a cycle. Remove a conflicting prerequisite first.");
  }
};

const assertDependenciesComplete = async (taskId, currentUser) => {
  const openDependencies = await prisma.taskDependency.count({
    where: {
      taskId,
      dependsOn: {
        deletedAt: null,
        organizationId: currentUser.organizationId,
        status: { not: "COMPLETED" },
      },
    },
  });
  if (openDependencies) {
    throw new ApiError(409, `Complete ${openDependencies} prerequisite task${openDependencies === 1 ? "" : "s"} first.`);
  }
};

const listTasks = async (currentUser, filters = {}) => {
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 100));
  const organizationWhere = { deletedAt: null, organizationId: currentUser.organizationId };
  const status = filters.status && filters.status !== "all" ? normalizeStatus(filters.status) : undefined;
  const priority = filters.priority && filters.priority !== "all" ? normalizePriority(filters.priority) : undefined;
  const dueFrom = filters.dueFrom ? parseDate(filters.dueFrom, "Due from") : undefined;
  const dueTo = filters.dueTo ? parseDate(filters.dueTo, "Due to") : undefined;
  const search = String(filters.search || "").trim();
  const where = {
    ...(hasPermission(currentUser, PERMISSIONS.TASKS_VIEW_ALL)
      ? organizationWhere
      : { ...organizationWhere, assignedToId: currentUser.id }),
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.assignedToId ? { assignedToId: filters.assignedToId } : {}),
    ...(filters.createdById ? { createdById: filters.createdById } : {}),
    ...(dueFrom || dueTo ? { deadline: { ...(dueFrom ? { gte: dueFrom } : {}), ...(dueTo ? { lte: dueTo } : {}) } } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
            { category: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      include: taskInclude,
      orderBy: filters.sort === "due" ? [{ deadline: "asc" }, { createdAt: "desc" }] : [{ status: "asc" }, { updatedAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      where,
    }),
    prisma.task.count({ where }),
  ]);

  return {
    pagination: { limit, page, pages: Math.max(1, Math.ceil(total / limit)), total },
    tasks: await attachSystemCustomData(currentUser, "tasks", tasks.map(serializeTask)),
  };
};

const createTask = async (currentUser, payload) => {
  if (!hasPermission(currentUser, PERMISSIONS.TASKS_CREATE)) {
    throw new ApiError(403, "You do not have permission to assign tasks.");
  }
  const customFields = await validateSystemCustomValues({
    currentUser,
    systemKey: "tasks",
    values: payload.customFields,
  });

  const assignee = payload.assignedToId
    ? await prisma.user.findFirst({
        where: {
          id: payload.assignedToId,
          organizationId: currentUser.organizationId,
          status: "ACTIVE",
        },
      })
    : null;
  if (payload.assignedToId && !assignee) throw new ApiError(400, "Choose a valid active team member.");

  const project = await prisma.project.findFirst({
    where: {
      id: payload.projectId,
      deletedAt: null,
      organizationId: currentUser.organizationId,
    },
  });

  if (!project) {
    throw new ApiError(400, "Choose a valid project before assigning the task.");
  }

  if (project.status === "ARCHIVED") {
    throw new ApiError(400, "Archived projects cannot receive new tasks.");
  }
  await validateSystemFields({
    currentUser,
    systemKey: "tasks",
    values: { ...payload, assignedToId: assignee?.id || null, projectId: project.id },
  });
  const dependencyIds = await validateDependencies(currentUser, payload.dependencyIds, project.id);

  const task = await prisma.$transaction(async (transaction) => {
    const created = await transaction.task.create({
      data: {
        assignedToId: assignee?.id || null,
        category: payload.category,
        createdById: currentUser.id,
        deadline: parseDate(payload.deadline, "Deadline"),
        description: payload.description,
        estimatedHours: payload.estimatedHours ?? null,
        organizationId: currentUser.organizationId,
        priority: normalizePriority(payload.priority),
        projectId: payload.projectId,
        requiredSkills: payload.requiredSkills,
        riskLevel: String(payload.riskLevel).toUpperCase(),
        successCriteria: payload.successCriteria || null,
        status: normalizeStatus(payload.status),
        title: payload.title,
      },
    });
    if (dependencyIds.length) {
      await transaction.taskDependency.createMany({
        data: dependencyIds.map((dependsOnTaskId) => ({ dependsOnTaskId, taskId: created.id })),
      });
    }
    await transaction.auditLog.create({
      data: {
        action: "CREATED",
        actorId: currentUser.id,
        entityId: created.id,
        entityType: "TASK",
        metadata: { assigneeId: created.assignedToId, dependencyIds, projectId: created.projectId },
        organizationId: currentUser.organizationId,
        summary: `Created task: ${created.title}`,
      },
    });
    await transaction.outboxEvent.create({
      data: {
        aggregateId: created.id,
        aggregateType: "TASK",
        organizationId: currentUser.organizationId,
        payload: { assigneeId: created.assignedToId, projectId: created.projectId },
        topic: "task.created",
      },
    });
    return created;
  });

  await refreshProjectWeights(project.id, currentUser.organizationId);

  const analyzedTask = await prisma.task.findUnique({
    include: taskInclude,
    where: { id: task.id },
  });

  await safelyNotify(() =>
    notifyTaskActivity({ actor: currentUser, event: "created", previousTask: null, task: analyzedTask }),
  );
  const savedCustomFields = await saveSystemEntityData({
    currentUser,
    entityId: analyzedTask.id,
    preparedData: customFields,
    systemKey: "tasks",
    values: payload.customFields,
  });
  return { ...serializeTask(analyzedTask), customFields: savedCustomFields };
};

const getTaskForAction = async (taskId, currentUser) => {
  const task = await prisma.task.findFirst({
    include: taskInclude,
    where: {
      id: taskId,
      deletedAt: null,
      organizationId: currentUser.organizationId,
    },
  });

  if (!task) {
    throw new ApiError(404, "Task not found.");
  }

  if (!hasPermission(currentUser, PERMISSIONS.TASKS_EDIT) && task.assignedToId !== currentUser.id) {
    throw new ApiError(403, "You can only update tasks assigned to you.");
  }

  return task;
};

const getTaskById = async (taskId, currentUser) => {
  const task = await prisma.task.findFirst({
    include: taskInclude,
    where: {
      id: taskId,
      deletedAt: null,
      organizationId: currentUser.organizationId,
    },
  });

  if (!task) {
    throw new ApiError(404, "Task not found.");
  }

  if (!hasPermission(currentUser, PERMISSIONS.TASKS_VIEW_ALL) && task.assignedToId !== currentUser.id) {
    throw new ApiError(403, "You can only view tasks assigned to you.");
  }

  return (await attachSystemCustomData(currentUser, "tasks", [serializeTask(task)]))[0];
};

const getTaskActivity = async (taskId, currentUser) => {
  const task = await prisma.task.findFirst({
    select: {
      assignedToId: true,
      createdAt: true,
      createdBy: {
        select: {
          fullName: true,
          id: true,
          role: true,
        },
      },
      id: true,
      timeLogs: {
        include: {
          user: {
            select: {
              fullName: true,
              id: true,
              role: true,
            },
          },
        },
        orderBy: {
          loggedAt: "desc",
        },
      },
      title: true,
    },
    where: {
      id: taskId,
      deletedAt: null,
      organizationId: currentUser.organizationId,
    },
  });

  if (!task) throw new ApiError(404, "Task not found.");
  if (!hasPermission(currentUser, PERMISSIONS.TASKS_VIEW_ALL) && task.assignedToId !== currentUser.id) {
    throw new ApiError(403, "You can only view activity for tasks assigned to you.");
  }

  const activity = await listEntityActivity(currentUser, "TASK", taskId);
  const auditedTimeLogIds = new Set(
    activity.map((entry) => entry.metadata?.timeLogId).filter(Boolean),
  );
  const legacyTimeLogs = task.timeLogs
    .filter((timeLog) => !auditedTimeLogIds.has(timeLog.id))
    .map((timeLog) => ({
      action: "time_logged",
      actor: {
        id: timeLog.user.id,
        name: timeLog.user.fullName,
        role: String(timeLog.user.role).toLowerCase(),
      },
      createdAt: timeLog.createdAt,
      entityId: task.id,
      entityType: "task",
      id: `time-log-${timeLog.id}`,
      metadata: {
        hours: Number(timeLog.hours),
        note: timeLog.note || null,
        timeLogId: timeLog.id,
      },
      summary: `Logged ${Number(timeLog.hours)}h on ${task.title}`,
    }));
  const creationEntry = activity.some((entry) => entry.action === "created")
    ? []
    : [{
        action: "created",
        actor: {
          id: task.createdBy.id,
          name: task.createdBy.fullName,
          role: String(task.createdBy.role).toLowerCase(),
        },
        createdAt: task.createdAt,
        entityId: task.id,
        entityType: "task",
        id: `task-created-${task.id}`,
        metadata: {},
        summary: `Created task: ${task.title}`,
      }];

  return [...activity, ...legacyTimeLogs, ...creationEntry].sort(
    (first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
  );
};

const updateTask = async (taskId, currentUser, payload) => {
  if (!hasPermission(currentUser, PERMISSIONS.TASKS_EDIT)) {
    throw new ApiError(403, "You do not have permission to edit tasks.");
  }

  const existingTask = await getTaskForAction(taskId, currentUser);
  if (payload.expectedVersion && payload.expectedVersion !== existingTask.version) {
    throw new ApiError(409, "This task changed since you opened it. Refresh before saving your changes.");
  }
  const existingCustomFields = await getSystemEntityData(currentUser, "tasks", taskId);
  const preparedCustomFields =
    payload.customFields === undefined
      ? existingCustomFields
      : await validateSystemCustomValues({
          currentUser,
          existingValues: existingCustomFields,
          systemKey: "tasks",
          values: payload.customFields,
        });
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
        deletedAt: null,
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
  if (payload.requiredSkills !== undefined) data.requiredSkills = payload.requiredSkills;
  if (payload.riskLevel !== undefined) data.riskLevel = String(payload.riskLevel).toUpperCase();
  if (payload.successCriteria !== undefined) data.successCriteria = payload.successCriteria || null;
  if (payload.title !== undefined) data.title = payload.title;

  if (payload.status !== undefined) {
    const status = normalizeStatus(payload.status);
    if (status === "COMPLETED") await assertDependenciesComplete(taskId, currentUser);
    data.status = status;
    data.aiAnalyzedAt = new Date();
    data.aiProgress = status === "COMPLETED" ? 100 : Math.min(existingTask.aiProgress || 0, 95);
    data.completedAt = status === "COMPLETED" ? existingTask.completedAt || new Date() : null;
  }
  await validateSystemFields({
    currentUser,
    systemKey: "tasks",
    values: { ...existingTask, ...data },
  });
  const nextProjectId = data.projectId || existingTask.projectId;
  const projectChanged = Boolean(data.projectId && data.projectId !== existingTask.projectId);
  if (projectChanged) {
    const dependentCount = await prisma.taskDependency.count({ where: { dependsOnTaskId: taskId } });
    if (dependentCount) {
      throw new ApiError(409, "Remove tasks that depend on this task before moving it to another project.");
    }
  }
  const requestedDependencyIds =
    payload.dependencyIds === undefined && projectChanged ? [] : payload.dependencyIds;
  const dependencyIds =
    requestedDependencyIds === undefined
      ? null
      : await validateDependencies(currentUser, requestedDependencyIds, nextProjectId, taskId);
  if (dependencyIds) {
    await assertDependencyGraphAcyclic(currentUser, taskId, nextProjectId, dependencyIds);
  }

  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.task.updateMany({
      data: { ...data, version: { increment: 1 } },
      where: {
        deletedAt: null,
        id: taskId,
        organizationId: currentUser.organizationId,
        ...(payload.expectedVersion ? { version: payload.expectedVersion } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new ApiError(409, "This task changed while you were editing it. Refresh and try again.");
    }
    if (dependencyIds) {
      await transaction.taskDependency.deleteMany({ where: { taskId } });
      if (dependencyIds.length) {
        await transaction.taskDependency.createMany({
          data: dependencyIds.map((dependsOnTaskId) => ({ dependsOnTaskId, taskId })),
        });
      }
    }
    await transaction.outboxEvent.create({
      data: {
        aggregateId: taskId,
        aggregateType: "TASK",
        organizationId: currentUser.organizationId,
        payload: { fields: Object.keys(data), projectId: nextProjectId },
        topic: "task.updated",
      },
    });
  });

  if (data.projectId && data.projectId !== existingTask.projectId) {
    await refreshProjectWeights(existingTask.projectId, currentUser.organizationId);
    await refreshProjectWeights(data.projectId, currentUser.organizationId);
  } else if (payload.status !== undefined) {
    await updateProjectProgress(nextProjectId, currentUser.organizationId);
  }

  const updatedTask = await prisma.task.findUnique({ include: taskInclude, where: { id: taskId } });
  const changes = buildChangeSet(existingTask, updatedTask, taskChangeFields);
  const completedTransition =
    updatedTask.status === "COMPLETED" && existingTask.status !== "COMPLETED";
  if (changes.length) {
    await safelyNotify(() =>
      notifyTaskActivity({
        actor: currentUser,
        event: "updated",
        previousTask: existingTask,
        task: updatedTask,
      }),
    );
    await safelyRecordAudit({
      action: completedTransition ? "COMPLETED" : "UPDATED",
      actor: currentUser,
      entityId: updatedTask.id,
      entityType: "TASK",
      metadata: { changes },
      summary: `${completedTransition ? "Completed" : "Updated"} task: ${updatedTask.title}`,
    });
  }
  const customFields =
    payload.customFields === undefined
      ? existingCustomFields
      : await saveSystemEntityData({
          currentUser,
          entityId: taskId,
          existingValues: existingCustomFields,
          preparedData: preparedCustomFields,
          systemKey: "tasks",
          values: payload.customFields,
        });
  return { ...serializeTask(updatedTask), customFields };
};

const updateTaskStatus = async (taskId, payload, currentUser) => {
  const existingTask = await getTaskForAction(taskId, currentUser);

  const normalizedStatus = normalizeStatus(payload.status);
  if (normalizedStatus === "COMPLETED") await assertDependenciesComplete(taskId, currentUser);
  const task = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.task.updateMany({
      data: {
        aiAnalyzedAt: new Date(),
        aiProgress: normalizedStatus === "COMPLETED" ? 100 : Math.min(existingTask.aiProgress || 0, 95),
        completedAt: normalizedStatus === "COMPLETED" ? existingTask.completedAt || new Date() : null,
        status: normalizedStatus,
        version: { increment: 1 },
      },
      where: {
        deletedAt: null,
        id: taskId,
        organizationId: currentUser.organizationId,
        ...(payload.expectedVersion ? { version: payload.expectedVersion } : {}),
      },
    });
    if (updated.count !== 1) throw new ApiError(409, "This task changed in another session. Refresh before updating it.");
    const nextTask = await transaction.task.findUnique({ include: taskInclude, where: { id: taskId } });
    await transaction.auditLog.create({
      data: {
        action: normalizedStatus === "COMPLETED" ? "COMPLETED" : "STATUS_CHANGED",
        actorId: currentUser.id,
        entityId: taskId,
        entityType: "TASK",
        metadata: { changes: buildChangeSet(existingTask, nextTask, taskChangeFields) },
        organizationId: currentUser.organizationId,
        summary: `Moved ${nextTask.title} to ${String(nextTask.status).toLowerCase().replace("_", " ")}`,
      },
    });
    return nextTask;
  });

  await updateProjectProgress(task.projectId, currentUser.organizationId);

  await safelyNotify(() =>
    notifyTaskActivity({
      actor: currentUser,
      event: "updated",
      previousTask: existingTask,
      task,
    }),
  );

  return (await attachSystemCustomData(currentUser, "tasks", [serializeTask(task)]))[0];
};

const createTimeLog = async (taskId, currentUser, payload) => {
  const task = await getTaskForAction(taskId, currentUser);
  if (task.status === "COMPLETED") {
    throw new ApiError(409, "Reopen the task before adding another work log.");
  }

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

  await safelyNotify(() =>
    notifyTaskActivity({
      actor: currentUser,
      event: "time_logged",
      previousTask: task,
      task,
    }),
  );

  await safelyRecordAudit({
    action: "TIME_LOGGED",
    actor: currentUser,
    entityId: task.id,
    entityType: "TASK",
    metadata: {
      hours: Number(timeLog.hours),
      note: payload.note || null,
      timeLogId: timeLog.id,
    },
    summary: `Logged ${Number(timeLog.hours)}h on ${task.title}`,
  });

  return serializeTimeLog(analyzedTimeLog);
};

const deleteTask = async (taskId, currentUser) => {
  if (!hasPermission(currentUser, PERMISSIONS.TASKS_DELETE)) {
    throw new ApiError(403, "You do not have permission to delete tasks.");
  }

  const task = await getTaskForAction(taskId, currentUser);
  await prisma.$transaction([
    prisma.task.update({ data: { deletedAt: new Date(), version: { increment: 1 } }, where: { id: taskId } }),
    prisma.auditLog.create({
      data: {
        action: "DELETED",
        actorId: currentUser.id,
        entityId: task.id,
        entityType: "TASK",
        metadata: { projectId: task.projectId, softDelete: true },
        organizationId: currentUser.organizationId,
        summary: `Deleted task: ${task.title}`,
      },
    }),
    prisma.outboxEvent.create({
      data: {
        aggregateId: task.id,
        aggregateType: "TASK",
        organizationId: currentUser.organizationId,
        payload: { projectId: task.projectId },
        topic: "task.deleted",
      },
    }),
  ]);
  await refreshProjectWeights(task.projectId, currentUser.organizationId);
  await safelyNotify(() =>
    notifyTaskActivity({
      actor: currentUser,
      event: "deleted",
      previousTask: task,
      task: { ...task, assignedToId: null },
    }),
  );
};

const serializeComment = (comment) => ({
  author: {
    id: comment.author.id,
    name: comment.author.fullName,
    role: String(comment.author.role).toLowerCase(),
  },
  body: comment.body,
  createdAt: comment.createdAt,
  editedAt: comment.editedAt,
  id: comment.id,
  mentions: comment.mentions || [],
});

const listTaskComments = async (taskId, currentUser) => {
  await getTaskById(taskId, currentUser);
  const comments = await prisma.taskComment.findMany({
    include: { author: true },
    orderBy: { createdAt: "asc" },
    take: 300,
    where: { deletedAt: null, taskId },
  });
  return comments.map(serializeComment);
};

const createTaskComment = async (taskId, currentUser, payload) => {
  const task = await getTaskForAction(taskId, currentUser);
  const mentionIds = [...new Set(payload.mentions || [])].filter((id) => id !== currentUser.id);
  const mentionedUsers = mentionIds.length
    ? await prisma.user.findMany({
        select: { id: true },
        where: { id: { in: mentionIds }, organizationId: currentUser.organizationId, status: "ACTIVE" },
      })
    : [];
  if (mentionedUsers.length !== mentionIds.length) throw new ApiError(400, "One or more mentioned users are invalid.");

  const result = await prisma.$transaction(async (transaction) => {
    const created = await transaction.taskComment.create({
      data: { authorId: currentUser.id, body: payload.body, mentions: mentionIds, taskId },
      include: { author: true },
    });
    const watchers = await transaction.taskWatcher.findMany({ select: { userId: true }, where: { taskId } });
    const recipients = [...new Set([
      ...mentionIds,
      ...watchers.map((watcher) => watcher.userId),
      task.assignedToId,
      task.createdById,
    ].filter((id) => id && id !== currentUser.id))];
    if (recipients.length) {
      await transaction.notification.createMany({
        data: recipients.map((recipientId) => ({
          actionUrl: `/tasks/${taskId}`,
          actorId: currentUser.id,
          entityId: taskId,
          entityType: "task",
          message: `${currentUser.fullName} commented on "${task.title}".`,
          organizationId: currentUser.organizationId,
          recipientId,
          title: mentionIds.includes(recipientId) ? "You were mentioned" : "New task comment",
          type: mentionIds.includes(recipientId) ? "TASK_MENTION" : "TASK_COMMENT",
        })),
      });
    }
    await transaction.auditLog.create({
      data: {
        action: "COMMENTED",
        actorId: currentUser.id,
        entityId: taskId,
        entityType: "TASK",
        metadata: { commentId: created.id, mentions: mentionIds },
        organizationId: currentUser.organizationId,
        summary: `Commented on task: ${task.title}`,
      },
    });
    const outboxEvent = await transaction.outboxEvent.create({
      data: {
        aggregateId: taskId,
        aggregateType: "TASK",
        organizationId: currentUser.organizationId,
        payload: {
          commentId: created.id,
          push: {
            actionUrl: `/tasks/${taskId}`,
            entityId: taskId,
            entityType: "task",
            message: `${currentUser.fullName} commented on "${task.title}".`,
            title: "New task comment",
            type: "TASK_COMMENT",
          },
          recipientIds: recipients,
        },
        topic: "task.commented",
      },
    });
    return { comment: created, outboxEventId: outboxEvent.id };
  });
  await safelyDeliverOutboxEvent(result.outboxEventId);
  return serializeComment(result.comment);
};

const setTaskWatching = async (taskId, currentUser, watching) => {
  await getTaskById(taskId, currentUser);
  if (watching) {
    await prisma.taskWatcher.upsert({
      create: { taskId, userId: currentUser.id },
      update: {},
      where: { taskId_userId: { taskId, userId: currentUser.id } },
    });
  } else {
    await prisma.taskWatcher.deleteMany({ where: { taskId, userId: currentUser.id } });
  }
  return { watching: Boolean(watching) };
};

const listTaskAttachments = async (taskId, currentUser) => {
  await getTaskById(taskId, currentUser);
  return prisma.taskAttachment.findMany({
    include: { uploadedBy: { select: { fullName: true, id: true } } },
    orderBy: { createdAt: "desc" },
    where: { taskId },
  });
};

const createTaskAttachment = async (taskId, currentUser, payload) => {
  const task = await getTaskForAction(taskId, currentUser);
  return prisma.$transaction(async (transaction) => {
    const attachment = await transaction.taskAttachment.create({
      data: { ...payload, taskId, uploadedById: currentUser.id },
      include: { uploadedBy: { select: { fullName: true, id: true } } },
    });
    await transaction.auditLog.create({
      data: {
        action: "ATTACHED",
        actorId: currentUser.id,
        entityId: taskId,
        entityType: "TASK",
        metadata: { attachmentId: attachment.id, name: attachment.name },
        organizationId: currentUser.organizationId,
        summary: `Attached ${attachment.name} to ${task.title}`,
      },
    });
    return attachment;
  });
};

const getTaskStats = async (currentUser) => {
  const organizationWhere = { deletedAt: null, organizationId: currentUser.organizationId };
  const where = hasPermission(currentUser, PERMISSIONS.TASKS_VIEW_ALL)
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
  createTaskAttachment,
  createTaskComment,
  createTimeLog,
  createTask,
  deleteTask,
  dependencyGraphHasCycle,
  getTaskActivity,
  getTaskById,
  getTaskStats,
  listTaskAttachments,
  listTaskComments,
  listTasks,
  setTaskWatching,
  serializeTask,
  taskInclude,
  updateTask,
  updateTaskStatus,
};
