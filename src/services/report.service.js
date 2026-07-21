const prisma = require("../db/prisma");
const { calculateWeightedProjectProgress } = require("./analysis.service");
const { serializeAuditLog } = require("./audit.service");

const DAY_MS = 86_400_000;
const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value));
const percent = (value, total) => (total > 0 ? Math.round((value / total) * 100) : 0);
const dateKey = (value) => new Date(value).toISOString().slice(0, 10);

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const getWorkingDays = (start, end) => {
  let count = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    if (![0, 6].includes(cursor.getDay())) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
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

  const [organization, users, tasks, projects, scans, auditEntries] = await Promise.all([
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
      where: { organizationId: currentUser.organizationId },
    }),
    prisma.project.findMany({
      include: {
        owner: { select: { fullName: true } },
        tasks: {
          select: { aiProgress: true, projectWeight: true, status: true },
        },
      },
      where: { organizationId: currentUser.organizationId },
    }),
    prisma.attendanceScan.findMany({
      select: { scannedAt: true, userId: true },
      where: { accepted: true, organizationId: currentUser.organizationId, scannedAt: { gte: start } },
    }),
    prisma.auditLog.findMany({
      include: { actor: { select: { fullName: true, id: true, role: true } } },
      orderBy: { createdAt: "desc" },
      take: 8,
      where: { organizationId: currentUser.organizationId },
    }),
  ]);

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
  const todayPresent = new Set(scans.filter((scan) => dateKey(scan.scannedAt) === dateKey(today)).map((scan) => scan.userId));
  const loggedHours = tasks.reduce(
    (total, task) => total + task.timeLogs.reduce((taskTotal, log) => taskTotal + toNumber(log.hours), 0),
    0,
  );
  const workdayHours = organization
    ? Math.max(
        1,
        (Number(organization.workdayEnd.slice(0, 2)) * 60 + Number(organization.workdayEnd.slice(3)) -
          (Number(organization.workdayStart.slice(0, 2)) * 60 + Number(organization.workdayStart.slice(3)))) /
          60,
      )
    : 8;
  const availableHours = users.length * getWorkingDays(start, end) * workdayHours;

  const timeline = Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const key = dateKey(date);
    const present = new Set(scans.filter((scan) => dateKey(scan.scannedAt) === key).map((scan) => scan.userId)).size;
    return {
      completed: completedTasks.filter((task) => task.completedAt && dateKey(task.completedAt) === key).length,
      created: tasks.filter((task) => dateKey(task.createdAt) === key).length,
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
        utilization: Math.min(100, percent(plannedHours, workdayHours * 5)),
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

  const taskStatuses = ["NEW", "ACTIVE", "IN_PROGRESS", "COMPLETED"].map((status) => ({
    key: status === "NEW" ? "open" : status.toLowerCase(),
    value: tasks.filter((task) => task.status === status).length,
  }));
  const projectHealth = ["on_track", "at_risk", "completed", "archived"].map((health) => ({
    key: health,
    value: projectRows.filter((project) => project.health === health).length,
  }));

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
  getOverviewReport,
};
