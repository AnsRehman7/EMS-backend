const prisma = require("../db/prisma");
const { calculateWeightedProjectProgress } = require("./analysis.service");
const { serializeAuditLog } = require("./audit.service");

const DAY_MS = 86_400_000;
const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value));
const percent = (value, total) => (total > 0 ? Math.round((value / total) * 100) : 0);
const dateKey = (value, timeZone = "UTC") =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(new Date(value));

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const getWorkingDays = (start, end, organization = {}) => {
  let count = 0;
  const cursor = new Date(start);
  const workingDays = new Set(organization.workingDays?.length ? organization.workingDays : [1, 2, 3, 4, 5]);
  const holidays = new Set(organization.holidays || []);
  while (cursor < end) {
    const key = dateKey(cursor, organization.timezone || "UTC");
    const weekday = new Date(`${key}T00:00:00.000Z`).getUTCDay();
    if (workingDays.has(weekday) && !holidays.has(key)) {
      count += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
};

const averageMetric = (rows, key) => {
  const values = rows
    .map((row) => row?.[key])
    .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number);
  return values.length
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100
    : null;
};

const getProjectProgress = (project) => {
  if (!project.tasks.length) return project.aiProgress || 0;
  return calculateWeightedProjectProgress(project.tasks);
};

const getProjectHealth = (project) => {
  const status = String(project.status).toLowerCase();
  const progress = getProjectProgress(project);
  if (status === "archived") return "archived";
  if (status === "completed" || progress === 100) return "completed";
  if (!project.dueDate) return "on_track";
  const due = new Date(project.dueDate);
  due.setHours(23, 59, 59, 999);
  if (due < new Date()) return "at_risk";
  const daysRemaining = Math.ceil((due.getTime() - Date.now()) / DAY_MS);
  return daysRemaining <= 7 && progress < 75 ? "at_risk" : "on_track";
};

const getOverviewReport = async (currentUser, requestedDays = 30) => {
  const days = Math.max(7, Math.min(Number(requestedDays) || 30, 90));
  const end = new Date();
  const start = startOfDay(new Date(end.getTime() - (days - 1) * DAY_MS));
  const today = startOfDay(end);

  const [organization, users, tasks, projects, scans, auditEntries, projectPlans] = await Promise.all([
    prisma.organization.findUnique({ where: { id: currentUser.organizationId } }),
    prisma.user.findMany({
      orderBy: { fullName: "asc" },
      where: { organizationId: currentUser.organizationId, status: "ACTIVE" },
    }),
    prisma.task.findMany({
      include: {
        assignedTo: true,
        project: { select: { name: true } },
        timeLogs: { where: { loggedAt: { gte: start } } },
      },
      where: { deletedAt: null, organizationId: currentUser.organizationId },
    }),
    prisma.project.findMany({
      include: {
        owner: { select: { fullName: true } },
        tasks: {
          select: { aiProgress: true, projectWeight: true, status: true },
        },
      },
      where: { deletedAt: null, organizationId: currentUser.organizationId },
    }),
    prisma.attendanceScan.findMany({
      select: { direction: true, scannedAt: true, userId: true },
      where: { accepted: true, direction: "IN", organizationId: currentUser.organizationId, scannedAt: { gte: start } },
    }),
    prisma.auditLog.findMany({
      include: { actor: { select: { fullName: true, id: true, role: true } } },
      orderBy: { createdAt: "desc" },
      take: 8,
      where: { organizationId: currentUser.organizationId },
    }),
    prisma.projectPlan.findMany({
      include: {
        evaluations: { orderBy: { evaluatedAt: "desc" }, where: { evaluatedAt: { gte: start } } },
        project: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      where: {
        OR: [{ createdAt: { gte: start } }, { evaluations: { some: { evaluatedAt: { gte: start } } } }],
        organizationId: currentUser.organizationId,
      },
    }),
  ]);
  const timeZone = organization?.timezone || "UTC";
  const keyFor = (value) => dateKey(value, timeZone);

  const activeTasks = tasks.filter((task) => task.status !== "COMPLETED");
  const completedTasks = tasks.filter((task) => task.status === "COMPLETED");
  const overdueTasks = activeTasks.filter((task) => task.deadline && new Date(task.deadline) < today);
  const activeProjects = projects.filter((project) => !["ARCHIVED", "COMPLETED"].includes(project.status));
  const projectRows = projects.map((project) => ({
    dueDate: project.dueDate,
    health: getProjectHealth(project),
    id: project.id,
    name: project.name,
    ownerName: project.owner?.fullName || "Unassigned",
    progress: getProjectProgress(project),
    status: String(project.status).toLowerCase(),
  }));
  const atRiskProjects = projectRows.filter((project) => project.health === "at_risk");
  const todayPresent = new Set(scans.filter((scan) => keyFor(scan.scannedAt) === keyFor(today)).map((scan) => scan.userId));
  const loggedHours = tasks.reduce(
    (total, task) => total + task.timeLogs.reduce((taskTotal, log) => taskTotal + toNumber(log.hours), 0),
    0,
  );
  const windowWorkingDays = getWorkingDays(start, end, organization);
  const workingDaysPerWeek = Math.max(1, new Set(organization?.workingDays?.length ? organization.workingDays : [1, 2, 3, 4, 5]).size);
  const availableHours = users.reduce(
    (sum, user) => sum + (toNumber(user.weeklyCapacityHours) * windowWorkingDays) / workingDaysPerWeek,
    0,
  );

  const timeline = Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const key = keyFor(date);
    const present = new Set(scans.filter((scan) => keyFor(scan.scannedAt) === key).map((scan) => scan.userId)).size;
    return {
      completed: completedTasks.filter((task) => task.completedAt && keyFor(task.completedAt) === key).length,
      created: tasks.filter((task) => keyFor(task.createdAt) === key).length,
      date: key,
      label: new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(date),
      present,
      attendanceRate: percent(present, users.length),
    };
  });

  const workload = users
    .map((member) => {
      const memberTasks = activeTasks.filter((task) => task.assignedToId === member.id);
      const memberLogs = tasks
        .filter((task) => task.assignedToId === member.id)
        .flatMap((task) => task.timeLogs);
      const plannedHours = memberTasks.reduce((total, task) => total + toNumber(task.estimatedHours), 0);
      return {
        activeTasks: memberTasks.length,
        department: member.department || "Unassigned",
        id: member.id,
        loggedHours: memberLogs.reduce((total, log) => total + toNumber(log.hours), 0),
        name: member.fullName,
        overdueTasks: memberTasks.filter((task) => task.deadline && new Date(task.deadline) < today).length,
        plannedHours,
        role: String(member.role).toLowerCase(),
        utilization: Math.min(
          100,
          percent(plannedHours, (toNumber(member.weeklyCapacityHours) * windowWorkingDays) / workingDaysPerWeek),
        ),
      };
    })
    .sort((a, b) => b.activeTasks - a.activeTasks)
    .slice(0, 8);

  const departmentNames = [...new Set(users.map((member) => member.department || "Unassigned"))];
  const departments = departmentNames
    .map((department) => {
      const members = users.filter((member) => (member.department || "Unassigned") === department);
      const memberIds = new Set(members.map((member) => member.id));
      const departmentTasks = tasks.filter((task) => task.assignedToId && memberIds.has(task.assignedToId));
      return {
        activeTasks: departmentTasks.filter((task) => task.status !== "COMPLETED").length,
        completionRate: percent(
          departmentTasks.filter((task) => task.status === "COMPLETED").length,
          departmentTasks.length,
        ),
        members: members.length,
        name: department,
      };
    })
    .sort((a, b) => b.members - a.members);

  const taskStatuses = ["NEW", "ACTIVE", "IN_PROGRESS", "BLOCKED", "COMPLETED"].map((status) => ({
    key: status === "NEW" ? "open" : status.toLowerCase(),
    value: tasks.filter((task) => task.status === status).length,
  }));
  const projectHealth = ["on_track", "at_risk", "completed", "archived"].map((health) => ({
    key: health,
    value: projectRows.filter((project) => project.health === health).length,
  }));
  const planEvaluations = projectPlans.flatMap((plan) =>
    plan.evaluations.map((evaluation) => ({
      evaluatedAt: evaluation.evaluatedAt,
      id: evaluation.id,
      metrics: evaluation.metrics && typeof evaluation.metrics === "object" ? evaluation.metrics : {},
      planId: plan.id,
      planVersion: plan.version,
      projectId: plan.projectId,
      projectName: plan.project.name,
    })),
  );
  const evaluationMetrics = planEvaluations.map((evaluation) => evaluation.metrics);
  const generatedPlans = projectPlans.filter((plan) => plan.createdAt >= start);
  const planningResearch = {
    approvalRate: percent(generatedPlans.filter((plan) => plan.status === "APPROVED").length, generatedPlans.length),
    averageDependencyViolations: averageMetric(evaluationMetrics, "dependencyViolations"),
    averageEffortMeanAbsoluteError: averageMetric(evaluationMetrics, "effortMeanAbsoluteError"),
    averageGenerationSeconds: averageMetric(evaluationMetrics, "generationSeconds"),
    averageManagerOverrideRate: averageMetric(evaluationMetrics, "managerOverrideRate"),
    averagePlanningTimeSavedMinutes: averageMetric(evaluationMetrics, "planningTimeSavedMinutes"),
    averageRequirementCoverage: averageMetric(evaluationMetrics, "requirementCoverage"),
    averageScheduleViolations: averageMetric(evaluationMetrics, "scheduleViolations"),
    deterministicFallbackRate: percent(
      generatedPlans.filter((plan) => plan.model === "staffflow-deterministic-v1").length,
      generatedPlans.length,
    ),
    evaluatedPlans: new Set(planEvaluations.map((evaluation) => evaluation.planId)).size,
    evaluations: planEvaluations,
    generatedPlans: generatedPlans.length,
  };

  return {
    attention: {
      overdueTasks: overdueTasks
        .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
        .slice(0, 6)
        .map((task) => ({
          assigneeName: task.assignedTo?.fullName || "Unassigned",
          deadline: task.deadline,
          id: task.id,
          projectName: task.project?.name || "No project",
          title: task.title,
        })),
      projects: atRiskProjects.sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0)).slice(0, 6),
    },
    departments,
    period: { days, end, start },
    planningResearch,
    projectHealth,
    recentActivity: auditEntries.map(serializeAuditLog),
    summary: {
      activeMembers: users.length,
      activeProjects: activeProjects.length,
      activeTasks: activeTasks.length,
      attendanceToday: percent(todayPresent.size, users.length),
      completedTasks: completedTasks.length,
      completionRate: percent(completedTasks.length, tasks.length),
      loggedHours: Math.round(loggedHours * 10) / 10,
      overdueTasks: overdueTasks.length,
      projectsAtRisk: atRiskProjects.length,
      utilization: percent(loggedHours, availableHours),
    },
    taskStatuses,
    timeline,
    workload,
  };
};

module.exports = {
  averageMetric,
  getWorkingDays,
  getOverviewReport,
};
