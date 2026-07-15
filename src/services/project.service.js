const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { canManageWork, canViewOrganizationWork } = require("../utils/roles");
const { calculateWeightedProjectProgress } = require("./analysis.service");
const { serializeTask, taskInclude } = require("./task.service");

const normalizeProjectStatus = (status = "active") => String(status).trim().toUpperCase();
const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value));

const parseDate = (value, label) => {
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, `${label} must be a valid date.`);
  }

  return parsed;
};

const assertPrivileged = (currentUser) => {
  if (!canManageWork(currentUser)) {
    throw new ApiError(403, "You do not have permission to manage projects.");
  }
};

const getProjectAccessWhere = (currentUser) => {
  const organizationWhere = { organizationId: currentUser.organizationId };
  if (canViewOrganizationWork(currentUser)) return organizationWhere;
  return { ...organizationWhere, tasks: { some: { assignedToId: currentUser.id } } };
};

const getTaskScopeWhere = (currentUser) => {
  if (canViewOrganizationWork(currentUser)) return undefined;
  return { assignedToId: currentUser.id };
};

const validateProjectDates = (startDate, dueDate) => {
  if (startDate && dueDate && startDate.getTime() > dueDate.getTime()) {
    throw new ApiError(400, "Project start date cannot be after the due date.");
  }
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
    createdAt: project.createdAt,
    createdById: project.createdById,
    createdByName: project.createdBy?.fullName || "Manager",
    description: project.description || "",
    dueDate: project.dueDate ? project.dueDate.toISOString().slice(0, 10) : "",
    health: getProjectHealth({ dueDate: project.dueDate, progress, status }),
    id: project.id,
    aiAnalyzedAt: project.aiAnalyzedAt,
    aiSummary: project.aiSummary || "",
    name: project.name,
    progress,
    startDate: project.startDate ? project.startDate.toISOString().slice(0, 10) : "",
    status,
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

  return projects.map((project) => serializeProject(project));
};

const getProjectById = async (projectId, currentUser) => {
  const project = await prisma.project.findFirst({
    include: {
      createdBy: true,
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

  return serializeProject(project, { includeTasks: true });
};

const createProject = async (currentUser, payload) => {
  assertPrivileged(currentUser);

  const startDate = parseDate(payload.startDate, "Start date");
  const dueDate = parseDate(payload.dueDate, "Due date");
  validateProjectDates(startDate, dueDate);

  const project = await prisma.project.create({
    data: {
      createdById: currentUser.id,
      description: payload.description || null,
      dueDate,
      name: payload.name,
      organizationId: currentUser.organizationId,
      startDate,
      status: startDate && startDate.getTime() > Date.now() ? "PLANNED" : "ACTIVE",
    },
    include: {
      createdBy: true,
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
  });

  return serializeProject(project);
};

const updateProject = async (projectId, currentUser, payload) => {
  assertPrivileged(currentUser);

  const existingProject = await prisma.project.findFirst({
    where: {
      id: projectId,
      organizationId: currentUser.organizationId,
    },
  });

  if (!existingProject) {
    throw new ApiError(404, "Project not found.");
  }

  const data = {};
  if (payload.description !== undefined) data.description = payload.description || null;
  if (payload.dueDate !== undefined) data.dueDate = parseDate(payload.dueDate, "Due date");
  if (payload.name !== undefined) data.name = payload.name;
  if (payload.startDate !== undefined) data.startDate = parseDate(payload.startDate, "Start date");
  if (payload.status !== undefined) data.status = normalizeProjectStatus(payload.status);

  validateProjectDates(data.startDate ?? existingProject.startDate, data.dueDate ?? existingProject.dueDate);

  const project = await prisma.project.update({
    data,
    include: {
      createdBy: true,
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

  return serializeProject(project);
};

const deleteProject = async (projectId, currentUser) => {
  assertPrivileged(currentUser);

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

    return { archived: true, project: serializeProject(project) };
  }

  await prisma.project.delete({ where: { id: projectId } });
  return { deleted: true };
};

module.exports = {
  createProject,
  deleteProject,
  getProjectById,
  listProjects,
  serializeProject,
  updateProject,
};
