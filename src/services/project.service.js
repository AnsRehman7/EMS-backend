const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { hasPermission, PERMISSIONS } = require("../utils/permissions");
const { calculateWeightedProjectProgress } = require("./analysis.service");
const { generateProjectTaskPlan } = require("./projectPlanning.service");
const { notifyProjectActivity, safelyNotify } = require("./notification.service");
const { buildChangeSet, listEntityActivity, safelyRecordAudit } = require("./audit.service");
const { serializeTask, taskInclude } = require("./task.service");
const {
  attachSystemCustomData,
  deleteSystemEntityData,
  getSystemEntityData,
  saveSystemEntityData,
  validateSystemCustomValues,
  validateSystemFields,
} = require("./module.service");

const normalizeProjectStatus = (status = "active") => String(status).trim().toUpperCase();
const normalizeProjectPriority = (priority = "normal") => String(priority).trim().toUpperCase();
const normalizeProjectCode = (code = "") =>
  String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-");
const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value));

const parseDate = (value, label) => {
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, `${label} must be a valid date.`);
  }

  return parsed;
};

const assertPermission = (currentUser, permission) => {
  if (!hasPermission(currentUser, permission)) {
    throw new ApiError(403, "You do not have permission to manage projects.");
  }
};

const getProjectAccessWhere = (currentUser) => {
  const organizationWhere = { organizationId: currentUser.organizationId };
  if (hasPermission(currentUser, PERMISSIONS.PROJECTS_VIEW_ALL)) return organizationWhere;
  return { ...organizationWhere, tasks: { some: { assignedToId: currentUser.id } } };
};

const getTaskScopeWhere = (currentUser) => {
  if (hasPermission(currentUser, PERMISSIONS.PROJECTS_VIEW_ALL)) return undefined;
  return { assignedToId: currentUser.id };
};

const validateProjectDates = (startDate, dueDate) => {
  if (startDate && dueDate && startDate.getTime() > dueDate.getTime()) {
    throw new ApiError(400, "Project start date cannot be after the due date.");
  }
};

const getProjectOwner = async (currentUser, ownerId) => {
  if (!ownerId) return null;

  const owner = await prisma.user.findFirst({
    where: {
      id: ownerId,
      organizationId: currentUser.organizationId,
      status: "ACTIVE",
    },
  });

  if (!owner) throw new ApiError(400, "Choose a valid active project owner.");
  return owner;
};

const assertUniqueProjectCode = async (organizationId, code, excludedProjectId) => {
  if (!code) return;

  const existing = await prisma.project.findFirst({
    where: {
      code,
      organizationId,
      ...(excludedProjectId ? { id: { not: excludedProjectId } } : {}),
    },
  });

  if (existing) throw new ApiError(400, "Project code is already in use in this workspace.");
};

const getProjectHealth = ({ dueDate, progress, status }) => {
  if (status === "archived") return "archived";
  if (status === "completed" || progress === 100) return "complete";
  if (!dueDate) return "on-track";

  const endOfDueDate = new Date(dueDate);
  endOfDueDate.setHours(23, 59, 59, 999);

  if (endOfDueDate.getTime() < Date.now()) return "overdue";

  const daysRemaining = Math.ceil((endOfDueDate.getTime() - Date.now()) / 86_400_000);
  return daysRemaining <= 7 ? "due-soon" : "on-track";
};

const projectChangeFields = [
  { field: "name", label: "Project name" },
  { field: "code", label: "Project code" },
  { field: "description", label: "Description" },
  { field: "objective", label: "Objective" },
  { field: "status", label: "Status" },
  { field: "priority", label: "Priority" },
  {
    field: "startDate",
    label: "Start date",
    read: (record) => record?.startDate?.toISOString().slice(0, 10) || null,
  },
  {
    field: "dueDate",
    label: "Due date",
    read: (record) => record?.dueDate?.toISOString().slice(0, 10) || null,
  },
  { field: "department", label: "Department" },
  { field: "clientName", label: "Client or stakeholder" },
  { field: "estimatedHours", label: "Estimated hours" },
  { field: "tags", label: "Tags" },
  {
    field: "ownerId",
    label: "Owner",
    read: (record) => record?.owner?.fullName || null,
  },
];

const serializeProject = (project, { includeTasks = false } = {}) => {
  const tasks = project.tasks || [];
  const taskCount = tasks.length;
  const completedTaskCount = tasks.filter((task) => task.status === "COMPLETED").length;
  const progress = taskCount === 0 ? project.aiProgress || 0 : calculateWeightedProjectProgress(tasks);
  const totalLoggedHours = tasks.reduce(
    (total, task) => total + (task.timeLogs || []).reduce((taskTotal, log) => taskTotal + toNumber(log.hours), 0),
    0
  );
  const status = String(project.status).toLowerCase();

  return {
    completedTaskCount,
    clientName: project.clientName || "",
    code: project.code || "",
    createdAt: project.createdAt,
    createdById: project.createdById,
    createdByName: project.createdBy?.fullName || "Manager",
    description: project.description || "",
    department: project.department || "",
    dueDate: project.dueDate ? project.dueDate.toISOString().slice(0, 10) : "",
    health: getProjectHealth({ dueDate: project.dueDate, progress, status }),
    id: project.id,
    estimatedHours: toNumber(project.estimatedHours),
    aiAnalyzedAt: project.aiAnalyzedAt,
    aiSummary: project.aiSummary || "",
    name: project.name,
    objective: project.objective || "",
    ownerId: project.ownerId || "",
    ownerName: project.owner?.fullName || project.createdBy?.fullName || "Unassigned",
    priority: String(project.priority || "NORMAL").toLowerCase(),
    progress,
    startDate: project.startDate ? project.startDate.toISOString().slice(0, 10) : "",
    status,
    tags: project.tags || [],
    taskCount,
    totalLoggedHours,
    updatedAt: project.updatedAt,
    ...(includeTasks ? { tasks: tasks.map(serializeTask) } : {}),
  };
};

const listProjects = async (currentUser) => {
  const taskScope = getTaskScopeWhere(currentUser);

  const projects = await prisma.project.findMany({
    include: {
      createdBy: true,
      owner: true,
      tasks: {
        orderBy: { createdAt: "desc" },
        select: {
          status: true,
          aiProgress: true,
          projectWeight: true,
          timeLogs: {
            select: {
              hours: true,
            },
          },
        },
        where: taskScope,
      },
    },
    orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
    where: getProjectAccessWhere(currentUser),
  });

  return attachSystemCustomData(currentUser, "projects", projects.map((project) => serializeProject(project)));
};

const getProjectById = async (projectId, currentUser) => {
  const project = await prisma.project.findFirst({
    include: {
      createdBy: true,
      owner: true,
      tasks: {
        include: taskInclude,
        orderBy: [{ status: "asc" }, { deadline: "asc" }, { createdAt: "desc" }],
        where: getTaskScopeWhere(currentUser),
      },
    },
    where: {
      id: projectId,
      ...getProjectAccessWhere(currentUser),
    },
  });

  if (!project) {
    throw new ApiError(404, "Project not found.");
  }

  const serialized = serializeProject(project, { includeTasks: true });
  const [withProjectFields] = await attachSystemCustomData(currentUser, "projects", [serialized]);
  withProjectFields.tasks = await attachSystemCustomData(currentUser, "tasks", withProjectFields.tasks);
  return withProjectFields;
};

const getProjectActivity = async (projectId, currentUser) => {
  const project = await prisma.project.findFirst({
    select: {
      createdAt: true,
      createdBy: {
        select: {
          fullName: true,
          id: true,
          role: true,
        },
      },
      id: true,
      name: true,
    },
    where: {
      id: projectId,
      ...getProjectAccessWhere(currentUser),
    },
  });

  if (!project) throw new ApiError(404, "Project not found.");
  const activity = await listEntityActivity(currentUser, "PROJECT", projectId);
  if (activity.some((entry) => entry.action === "created")) return activity;

  return [
    ...activity,
    {
      action: "created",
      actor: {
        id: project.createdBy.id,
        name: project.createdBy.fullName,
        role: String(project.createdBy.role).toLowerCase(),
      },
      createdAt: project.createdAt,
      entityId: project.id,
      entityType: "project",
      id: `project-created-${project.id}`,
      metadata: {},
      summary: `Created project: ${project.name}`,
    },
  ].sort(
    (first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
  );
};

const createProject = async (currentUser, payload) => {
  assertPermission(currentUser, PERMISSIONS.PROJECTS_CREATE);
  const customFields = await validateSystemCustomValues({
    currentUser,
    systemKey: "projects",
    values: payload.customFields,
  });

  const startDate = parseDate(payload.startDate, "Start date");
  const dueDate = parseDate(payload.dueDate, "Due date");
  validateProjectDates(startDate, dueDate);
  const code = normalizeProjectCode(payload.code);
  const owner = await getProjectOwner(currentUser, payload.ownerId || currentUser.id);
  await assertUniqueProjectCode(currentUser.organizationId, code);

  const taskPlan = payload.generateTasksWithAi
    ? await generateProjectTaskPlan({
        clientName: payload.clientName,
        description: payload.description,
        department: payload.department,
        dueDate,
        estimatedHours: payload.estimatedHours,
        objective: payload.objective,
        priority: payload.priority,
        tags: payload.tags,
        name: payload.name,
        startDate,
      })
    : null;

  const projectStatus = payload.status
    ? normalizeProjectStatus(payload.status)
    : startDate && startDate.getTime() > Date.now()
      ? "PLANNED"
      : "ACTIVE";
  await validateSystemFields({
    currentUser,
    systemKey: "projects",
    values: { ...payload, ownerId: owner?.id, status: projectStatus },
  });

  const project = await prisma.$transaction(async (transaction) => {
    const createdProject = await transaction.project.create({
      data: {
        aiAnalyzedAt: taskPlan ? new Date() : null,
        aiSummary: taskPlan?.summary || null,
        clientName: payload.clientName || null,
        code: code || null,
        createdById: currentUser.id,
        department: payload.department || null,
        description: payload.description || null,
        dueDate,
        estimatedHours: payload.estimatedHours ?? null,
        name: payload.name,
        objective: payload.objective || null,
        organizationId: currentUser.organizationId,
        ownerId: owner?.id || null,
        priority: normalizeProjectPriority(payload.priority),
        startDate,
        status: projectStatus,
        tags: payload.tags || [],
      },
    });

    if (taskPlan) {
      await transaction.task.createMany({
        data: taskPlan.tasks.map((task) => ({
          assignedToId: null,
          category: task.category,
          createdById: currentUser.id,
          deadline: parseDate(task.deadline, "Generated task deadline"),
          description: task.description,
          estimatedHours: task.estimatedHours,
          organizationId: currentUser.organizationId,
          priority: task.priority,
          projectId: createdProject.id,
          projectWeight: task.projectWeight,
          status: "NEW",
          successCriteria: task.successCriteria,
          title: task.title,
        })),
      });
    }

    return transaction.project.findUnique({
      include: {
        createdBy: true,
        owner: true,
        tasks: {
          select: {
            aiProgress: true,
            projectWeight: true,
            status: true,
            timeLogs: {
              select: {
                hours: true,
              },
            },
          },
        },
      },
      where: { id: createdProject.id },
    });
  });

  await safelyNotify(() =>
    notifyProjectActivity({ actor: currentUser, event: "created", previousProject: null, project }),
  );
  await safelyRecordAudit({
    action: "CREATED",
    actor: currentUser,
    entityId: project.id,
    entityType: "PROJECT",
    metadata: { generatedTaskCount: taskPlan?.tasks.length || 0, ownerId: project.ownerId },
    summary: `Created project: ${project.name}`,
  });

  const savedCustomFields = await saveSystemEntityData({
    currentUser,
    entityId: project.id,
    preparedData: customFields,
    systemKey: "projects",
    values: payload.customFields,
  });
  return { ...serializeProject(project), customFields: savedCustomFields };
};

const updateProject = async (projectId, currentUser, payload) => {
  assertPermission(currentUser, PERMISSIONS.PROJECTS_EDIT);

  const existingProject = await prisma.project.findFirst({
    include: {
      owner: true,
    },
    where: {
      id: projectId,
      organizationId: currentUser.organizationId,
    },
  });

  if (!existingProject) {
    throw new ApiError(404, "Project not found.");
  }
  const existingCustomFields = await getSystemEntityData(currentUser, "projects", projectId);
  const preparedCustomFields =
    payload.customFields === undefined
      ? existingCustomFields
      : await validateSystemCustomValues({
          currentUser,
          existingValues: existingCustomFields,
          systemKey: "projects",
          values: payload.customFields,
        });

  const data = {};
  if (payload.clientName !== undefined) data.clientName = payload.clientName || null;
  if (payload.code !== undefined) {
    data.code = normalizeProjectCode(payload.code) || null;
    await assertUniqueProjectCode(currentUser.organizationId, data.code, projectId);
  }
  if (payload.department !== undefined) data.department = payload.department || null;
  if (payload.description !== undefined) data.description = payload.description || null;
  if (payload.dueDate !== undefined) data.dueDate = parseDate(payload.dueDate, "Due date");
  if (payload.estimatedHours !== undefined) data.estimatedHours = payload.estimatedHours;
  if (payload.name !== undefined) data.name = payload.name;
  if (payload.objective !== undefined) data.objective = payload.objective || null;
  if (payload.ownerId !== undefined) {
    const owner = await getProjectOwner(currentUser, payload.ownerId);
    data.ownerId = owner?.id || null;
  }
  if (payload.priority !== undefined) data.priority = normalizeProjectPriority(payload.priority);
  if (payload.startDate !== undefined) data.startDate = parseDate(payload.startDate, "Start date");
  if (payload.status !== undefined) data.status = normalizeProjectStatus(payload.status);
  if (payload.tags !== undefined) data.tags = payload.tags;

  validateProjectDates(data.startDate ?? existingProject.startDate, data.dueDate ?? existingProject.dueDate);
  await validateSystemFields({
    currentUser,
    systemKey: "projects",
    values: { ...existingProject, ...data },
  });

  const project = await prisma.project.update({
    data,
    include: {
      createdBy: true,
      owner: true,
      tasks: {
        select: {
          status: true,
          aiProgress: true,
          projectWeight: true,
          timeLogs: {
            select: {
              hours: true,
            },
          },
        },
      },
    },
    where: { id: projectId },
  });
  const changes = buildChangeSet(existingProject, project, projectChangeFields);

  if (changes.length) {
    await safelyNotify(() =>
      notifyProjectActivity({ actor: currentUser, event: "updated", previousProject: existingProject, project }),
    );
    await safelyRecordAudit({
      action: project.status === "COMPLETED" && existingProject.status !== "COMPLETED" ? "COMPLETED" : "UPDATED",
      actor: currentUser,
      entityId: project.id,
      entityType: "PROJECT",
      metadata: { changes },
      summary: `Updated project: ${project.name}`,
    });
  }

  const customFields =
    payload.customFields === undefined
      ? existingCustomFields
      : await saveSystemEntityData({
          currentUser,
          entityId: projectId,
          existingValues: existingCustomFields,
          preparedData: preparedCustomFields,
          systemKey: "projects",
          values: payload.customFields,
        });
  return { ...serializeProject(project), customFields };
};

const deleteProject = async (projectId, currentUser) => {
  assertPermission(currentUser, PERMISSIONS.PROJECTS_DELETE);

  const existingProject = await prisma.project.findFirst({
    where: {
      id: projectId,
      organizationId: currentUser.organizationId,
    },
  });

  if (!existingProject) {
    throw new ApiError(404, "Project not found.");
  }

  const taskCount = await prisma.task.count({ where: { organizationId: currentUser.organizationId, projectId } });
  if (taskCount > 0) {
    const project = await prisma.project.update({
      data: { status: "ARCHIVED" },
      include: {
        createdBy: true,
        owner: true,
        tasks: {
          select: {
            status: true,
            aiProgress: true,
            projectWeight: true,
            timeLogs: {
              select: {
                hours: true,
              },
            },
          },
        },
      },
      where: { id: projectId },
    });

    await safelyNotify(() =>
      notifyProjectActivity({ actor: currentUser, event: "archived", previousProject: existingProject, project }),
    );
    await safelyRecordAudit({
      action: "ARCHIVED",
      actor: currentUser,
      entityId: project.id,
      entityType: "PROJECT",
      metadata: { taskCount },
      summary: `Archived project: ${project.name}`,
    });

    return { archived: true, project: serializeProject(project) };
  }

  await prisma.project.delete({ where: { id: projectId } });
  await deleteSystemEntityData(currentUser, "projects", projectId);
  await safelyNotify(() =>
    notifyProjectActivity({ actor: currentUser, event: "deleted", previousProject: existingProject, project: existingProject }),
  );
  await safelyRecordAudit({
    action: "DELETED",
    actor: currentUser,
    entityId: existingProject.id,
    entityType: "PROJECT",
    summary: `Deleted project: ${existingProject.name}`,
  });
  return { deleted: true };
};

module.exports = {
  createProject,
  deleteProject,
  getProjectActivity,
  getProjectById,
  listProjects,
  serializeProject,
  updateProject,
};
