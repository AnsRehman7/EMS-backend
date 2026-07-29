const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { hasPermission, PERMISSIONS } = require("../utils/permissions");
const { generateProjectPlanBlueprint } = require("./projectBlueprint.service");
const { safelyDeliverOutboxEvent } = require("./notification.service");

const DAY_MS = 86_400_000;
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const asNumber = (value) => (value === null || value === undefined ? 0 : Number(value));

const dateOnly = (value) => {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const utcDate = (value) => {
  const key = dateOnly(value);
  return key ? new Date(`${key}T00:00:00.000Z`) : null;
};

const planningCalendar = (organization = {}) => ({
  holidays: new Set((organization.holidays || []).map(dateOnly).filter(Boolean)),
  workingDays: new Set(organization.workingDays?.length ? organization.workingDays : [1, 2, 3, 4, 5]),
});
const isBusinessDay = (date, calendar) =>
  calendar.workingDays.has(date.getUTCDay()) && !calendar.holidays.has(dateOnly(date));
const moveToBusinessDay = (value, calendar = planningCalendar()) => {
  const date = new Date(value);
  while (!isBusinessDay(date, calendar)) date.setUTCDate(date.getUTCDate() + 1);
  return date;
};

const addBusinessDays = (value, amount, calendar = planningCalendar()) => {
  const date = moveToBusinessDay(value, calendar);
  let remaining = Math.max(0, amount);
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isBusinessDay(date, calendar)) remaining -= 1;
  }
  return date;
};

const countBusinessDays = (start, end, calendar = planningCalendar()) => {
  let cursor = moveToBusinessDay(start, calendar);
  const limit = new Date(end);
  let days = 0;
  while (cursor <= limit) {
    if (isBusinessDay(cursor, calendar)) days += 1;
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return Math.max(0, days);
};

const workdayHours = (organization) => {
  const [startHour, startMinute] = String(organization.workdayStart || "09:00").split(":").map(Number);
  const [endHour, endMinute] = String(organization.workdayEnd || "18:00").split(":").map(Number);
  return Math.max(1, Math.min(16, endHour + endMinute / 60 - startHour - startMinute / 60));
};

const requirementKey = (value, index) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return normalized || `REQ-${String(index + 1).padStart(3, "0")}`;
};

const normalizeRequirements = (items) => {
  const used = new Set();
  return items.slice(0, 40).map((item, index) => {
    let key = requirementKey(item.key, index);
    let suffix = 2;
    while (used.has(key)) {
      key = `${requirementKey(item.key, index).slice(0, 20)}-${suffix}`;
      suffix += 1;
    }
    used.add(key);
    return {
      acceptanceCriteria: item.acceptanceCriteria || null,
      description: String(item.description || item.title).trim(),
      key,
      priority: String(item.priority || "MUST").toUpperCase(),
      source: item.source || "manual",
      title: String(item.title || item.description).trim().slice(0, 160),
    };
  });
};

const deriveRequirements = (project) => {
  const source = [project.objective, project.description].filter(Boolean).join("\n");
  const lines = source
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 8)
    .slice(0, 24);
  const usable = lines.length ? lines : [`Deliver ${project.name} according to the approved project brief.`];
  return normalizeRequirements(
    usable.map((description, index) => ({
      description,
      key: `REQ-${String(index + 1).padStart(3, "0")}`,
      priority: "MUST",
      source: "project_brief",
      title: description.length > 80 ? `${description.slice(0, 77)}...` : description,
    })),
  );
};

const assertPlanningPermission = (currentUser) => {
  if (!hasPermission(currentUser, PERMISSIONS.PROJECTS_EDIT)) {
    throw new ApiError(403, "You do not have permission to generate or approve project plans.");
  }
};

const projectAccessWhere = (currentUser) => ({
  deletedAt: null,
  organizationId: currentUser.organizationId,
  ...(!hasPermission(currentUser, PERMISSIONS.PROJECTS_VIEW_ALL)
    ? { tasks: { some: { assignedToId: currentUser.id, deletedAt: null } } }
    : {}),
});

const getProject = async (currentUser, projectId) => {
  const project = await prisma.project.findFirst({
    include: { organization: true, requirements: { orderBy: { key: "asc" } } },
    where: { ...projectAccessWhere(currentUser), id: projectId },
  });
  if (!project) throw new ApiError(404, "Project not found.");
  return project;
};

const syncRequirements = async (currentUser, project, requestedRequirements) => {
  if (!requestedRequirements?.length && project.requirements.length) return project.requirements;
  const requirements = requestedRequirements?.length
    ? normalizeRequirements(requestedRequirements)
    : deriveRequirements(project);

  return prisma.$transaction(async (transaction) => {
    await transaction.projectRequirement.deleteMany({ where: { projectId: project.id } });
    await transaction.projectRequirement.createMany({
      data: requirements.map((requirement) => ({
        ...requirement,
        createdById: currentUser.id,
        organizationId: currentUser.organizationId,
        projectId: project.id,
      })),
    });
    return transaction.projectRequirement.findMany({
      orderBy: { key: "asc" },
      where: { projectId: project.id },
    });
  });
};

const topologicalTasks = (inputTasks) => {
  const warnings = [];
  const tasks = inputTasks.map((task) => ({ ...task, dependencyKeys: [...task.dependencyKeys] }));
  const byKey = new Map(tasks.map((task) => [task.key, task]));

  for (const task of tasks) {
    const valid = task.dependencyKeys.filter((key) => byKey.has(key) && key !== task.key);
    if (valid.length !== task.dependencyKeys.length) {
      warnings.push(`${task.key} contained an unknown or self-referencing dependency; it was removed.`);
    }
    task.dependencyKeys = [...new Set(valid)];
  }

  const indegree = new Map(tasks.map((task) => [task.key, task.dependencyKeys.length]));
  const queue = tasks.filter((task) => indegree.get(task.key) === 0);
  const ordered = [];
  while (queue.length) {
    const next = queue.shift();
    ordered.push(next);
    for (const candidate of tasks) {
      if (!candidate.dependencyKeys.includes(next.key)) continue;
      indegree.set(candidate.key, indegree.get(candidate.key) - 1);
      if (indegree.get(candidate.key) === 0) queue.push(candidate);
    }
  }

  if (ordered.length !== tasks.length) {
    const cyclic = tasks.filter((task) => !ordered.some((item) => item.key === task.key));
    warnings.push(`A dependency cycle involved ${cyclic.map((task) => task.key).join(", ")}; cyclic links were removed.`);
    cyclic.forEach((task) => ordered.push({ ...task, dependencyKeys: [] }));
  }
  return { ordered, warnings };
};

const recommendTeam = ({ businessDays, tasks, users, workloadHours, workingDaysPerWeek }) => {
  const plannedLoad = new Map();
  const capacity = new Map(
    users.map((user) => [
      user.id,
      Math.max(
        0,
        (asNumber(user.weeklyCapacityHours) * businessDays) / Math.max(1, workingDaysPerWeek) -
          (workloadHours.get(user.id) || 0),
      ),
    ]),
  );

  return tasks.map((task) => {
    if (!users.length) return { ...task, suggestedAssigneeId: null, suggestionReason: "No active team members are available." };
    const required = task.requiredSkills.map((skill) => skill.toLowerCase());
    const candidates = users.map((user) => {
      const skills = (user.skills || []).map((skill) => skill.toLowerCase());
      const matches = required.filter((skill) => skills.includes(skill));
      const skillScore = required.length ? matches.length / required.length : 0.5;
      const available = capacity.get(user.id) - (plannedLoad.get(user.id) || 0);
      const availabilityScore = Math.max(-1, Math.min(1, available / Math.max(1, asNumber(task.estimatedHours))));
      return { available, matches, score: skillScore * 70 + availabilityScore * 30, user };
    });
    candidates.sort((first, second) => second.score - first.score || second.available - first.available);
    const selected = candidates[0];
    plannedLoad.set(selected.user.id, (plannedLoad.get(selected.user.id) || 0) + asNumber(task.estimatedHours));
    const skillText = required.length
      ? `${selected.matches.length}/${required.length} required skills match`
      : "no specific skill constraint";
    const capacityText = selected.available >= 0
      ? `${round2(selected.available)}h estimated capacity remains before this task`
      : `${round2(Math.abs(selected.available))}h over current capacity before this task`;
    return {
      ...task,
      suggestedAssigneeId: selected.user.id,
      suggestionReason: `${selected.user.fullName}: ${skillText}; ${capacityText}.`,
    };
  });
};

const schedulePlan = ({ blueprint, organization, project, requirements, users, workloadHours }) => {
  const calendar = planningCalendar(organization);
  const start = moveToBusinessDay(utcDate(project.startDate) || utcDate(new Date()), calendar);
  const due = utcDate(project.dueDate);
  if (!due) throw new ApiError(400, "Set a project due date before generating a delivery plan.");
  if (start > due) throw new ApiError(400, "Project start date cannot be after its due date.");

  const businessDays = Math.max(1, countBusinessDays(start, due, calendar));
  const graph = topologicalTasks(blueprint.tasks);
  const recommended = recommendTeam({
    businessDays,
    tasks: graph.ordered,
    users,
    workloadHours,
    workingDaysPerWeek: calendar.workingDays.size,
  });
  const dailyHours = workdayHours(organization);
  const userById = new Map(users.map((user) => [user.id, user]));
  const taskEndDates = new Map();
  const userAvailableDates = new Map(
    users.map((user) => {
      const availablePerDay = Math.max(
        0.5,
        Math.min(dailyHours, asNumber(user.weeklyCapacityHours) / calendar.workingDays.size),
      );
      const backlogDays = Math.ceil((workloadHours.get(user.id) || 0) / availablePerDay);
      return [user.id, addBusinessDays(start, backlogDays, calendar)];
    }),
  );
  const warnings = [...graph.warnings];

  const tasks = recommended.map((task, position) => {
    const dependencyStart = task.dependencyKeys.reduce((latest, key) => {
      const dependencyEnd = taskEndDates.get(key);
      return dependencyEnd && dependencyEnd > latest ? dependencyEnd : latest;
    }, start);
    const afterDependencies = task.dependencyKeys.length ? addBusinessDays(dependencyStart, 1, calendar) : dependencyStart;
    const userAvailable = userAvailableDates.get(task.suggestedAssigneeId) || start;
    const scheduledStart = moveToBusinessDay(afterDependencies > userAvailable ? afterDependencies : userAvailable, calendar);
    const suggestedUser = userById.get(task.suggestedAssigneeId);
    const assigneeDailyHours = suggestedUser
      ? Math.max(
          0.5,
          Math.min(dailyHours, asNumber(suggestedUser.weeklyCapacityHours) / calendar.workingDays.size),
        )
      : dailyHours;
    const durationDays = Math.max(1, Math.ceil(asNumber(task.estimatedHours) / assigneeDailyHours));
    const scheduledEnd = addBusinessDays(scheduledStart, durationDays - 1, calendar);
    taskEndDates.set(task.key, scheduledEnd);
    if (task.suggestedAssigneeId) userAvailableDates.set(task.suggestedAssigneeId, addBusinessDays(scheduledEnd, 1, calendar));
    if (scheduledEnd > due) warnings.push(`${task.key} is scheduled after the project deadline.`);
    return { ...task, position, scheduledEnd, scheduledStart };
  });

  const coveredKeys = new Set(tasks.flatMap((task) => task.requirementKeys));
  const uncovered = requirements.filter((requirement) => !coveredKeys.has(requirement.key));
  uncovered.forEach((requirement) => warnings.push(`${requirement.key} is not covered by any planned task.`));
  if (blueprint.missingRequirements.length) warnings.push(...blueprint.missingRequirements.map((item) => `Missing input: ${item}`));

  const totalEstimatedHours = round2(tasks.reduce((sum, task) => sum + asNumber(task.estimatedHours), 0));
  const availableCapacityHours = round2(
    users.reduce(
      (sum, user) => sum + Math.max(0, (asNumber(user.weeklyCapacityHours) * businessDays) / calendar.workingDays.size - (workloadHours.get(user.id) || 0)),
      0,
    ),
  );
  if (totalEstimatedHours > availableCapacityHours && users.length) {
    warnings.push(`The plan needs ${totalEstimatedHours}h but the team has about ${availableCapacityHours}h available in the window.`);
  }
  const plannedHoursByUser = new Map();
  tasks.forEach((task) => {
    if (!task.suggestedAssigneeId) return;
    plannedHoursByUser.set(
      task.suggestedAssigneeId,
      (plannedHoursByUser.get(task.suggestedAssigneeId) || 0) + asNumber(task.estimatedHours),
    );
  });
  const teamCapacity = users.map((user) => {
    const existingWorkloadHours = round2(workloadHours.get(user.id) || 0);
    const windowCapacityHours = round2(
      (asNumber(user.weeklyCapacityHours) * businessDays) / calendar.workingDays.size,
    );
    const availableHours = round2(Math.max(0, windowCapacityHours - existingWorkloadHours));
    const plannedHours = round2(plannedHoursByUser.get(user.id) || 0);
    const utilization = availableHours > 0
      ? round2((plannedHours / availableHours) * 100)
      : plannedHours > 0
        ? 999
        : 0;
    if (plannedHours > availableHours) {
      warnings.push(`${user.fullName} is overloaded by ${round2(plannedHours - availableHours)}h in this delivery window.`);
    }
    return {
      availableHours,
      existingWorkloadHours,
      name: user.fullName,
      plannedHours,
      userId: user.id,
      utilization,
      windowCapacityHours,
    };
  });
  tasks
    .filter((task) => task.confidence < 60)
    .forEach((task) => warnings.push(`${task.key} has low planning confidence (${task.confidence}%). Review its scope and estimate.`));

  const milestones = blueprint.milestones.map((milestone, position) => {
    const milestoneTasks = tasks.filter((task) => task.milestoneKey === milestone.key);
    const targetDate = milestoneTasks.reduce(
      (latest, task) => (!latest || task.scheduledEnd > latest ? task.scheduledEnd : latest),
      null,
    );
    return { ...milestone, position, targetDate: targetDate || due };
  });
  const highRiskTaskCount = tasks.filter((task) => ["HIGH", "CRITICAL"].includes(task.riskLevel)).length;
  const requirementCoverage = requirements.length
    ? round2((coveredKeys.size / requirements.length) * 100)
    : 0;

  return {
    assumptions: blueprint.assumptions,
    metrics: {
      availableCapacityHours,
      averageConfidence: round2(tasks.reduce((sum, task) => sum + task.confidence, 0) / tasks.length),
      businessDays,
      dependencyCount: tasks.reduce((sum, task) => sum + task.dependencyKeys.length, 0),
      highRiskTaskCount,
      requirementCoverage,
      teamCapacity,
      totalEstimatedHours,
      uncoveredRequirementCount: uncovered.length,
    },
    milestones,
    summary: blueprint.summary,
    tasks,
    warnings: [...new Set(warnings)],
  };
};

const serializePlan = (plan) => ({
  approvedAt: plan.approvedAt,
  approvedBy: plan.approvedBy ? { id: plan.approvedBy.id, name: plan.approvedBy.fullName } : null,
  assumptions: plan.assumptions || [],
  createdAt: plan.createdAt,
  createdBy: plan.createdBy ? { id: plan.createdBy.id, name: plan.createdBy.fullName } : null,
  evaluations: plan.evaluations || [],
  generationMs: plan.generationMs,
  id: plan.id,
  manualBaselineMinutes: plan.manualBaselineMinutes,
  metrics: plan.metrics || {},
  milestones: (plan.milestones || []).map((milestone) => ({
    ...milestone,
    targetDate: dateOnly(milestone.targetDate),
  })),
  model: plan.model,
  projectId: plan.projectId,
  requirementsSnapshot: Array.isArray(plan.requirementsSnapshot) ? plan.requirementsSnapshot : [],
  reviewDurationSeconds: plan.reviewDurationSeconds,
  status: String(plan.status).toLowerCase(),
  summary: plan.summary,
  tasks: (plan.tasks || []).map((task) => ({
    ...task,
    estimatedHours: asNumber(task.estimatedHours),
    priority: String(task.priority).toLowerCase(),
    projectWeight: asNumber(task.projectWeight),
    riskLevel: String(task.riskLevel).toLowerCase(),
    scheduledEnd: dateOnly(task.scheduledEnd),
    scheduledStart: dateOnly(task.scheduledStart),
    suggestedAssignee: task.suggestedAssignee
      ? { id: task.suggestedAssignee.id, name: task.suggestedAssignee.fullName }
      : null,
    approvedAssignee: task.approvedAssignee
      ? { id: task.approvedAssignee.id, name: task.approvedAssignee.fullName }
      : null,
  })),
  version: plan.version,
  warnings: plan.warnings || [],
});

const planInclude = {
  approvedBy: { select: { fullName: true, id: true } },
  createdBy: { select: { fullName: true, id: true } },
  evaluations: { orderBy: { evaluatedAt: "desc" }, take: 5 },
  milestones: { orderBy: { position: "asc" } },
  project: { select: { name: true } },
  tasks: {
    include: {
      approvedAssignee: { select: { fullName: true, id: true } },
      suggestedAssignee: { select: { fullName: true, id: true } },
    },
    orderBy: { position: "asc" },
  },
};

const generatePlan = async (currentUser, projectId, options = {}) => {
  assertPlanningPermission(currentUser);
  const project = await getProject(currentUser, projectId);
  const projectStart = utcDate(project.startDate) || utcDate(new Date());
  const projectDue = utcDate(project.dueDate);
  if (!projectDue) throw new ApiError(400, "Set a project due date before generating a delivery plan.");
  if (projectStart > projectDue) throw new ApiError(400, "Project start date cannot be after its due date.");
  const requirements = await syncRequirements(currentUser, project, options.requirements);
  const [users, openTasks] = await Promise.all([
    prisma.user.findMany({
      select: { fullName: true, id: true, skills: true, weeklyCapacityHours: true },
      where: { organizationId: currentUser.organizationId, status: "ACTIVE" },
    }),
    prisma.task.findMany({
      select: {
        aiProgress: true,
        assignedToId: true,
        estimatedHours: true,
        timeLogs: { select: { hours: true } },
      },
      where: {
        assignedToId: { not: null },
        deletedAt: null,
        OR: [{ deadline: null }, { deadline: { lte: projectDue } }],
        organizationId: currentUser.organizationId,
        status: { not: "COMPLETED" },
      },
    }),
  ]);
  const workloadHours = new Map();
  openTasks.forEach((task) => {
    const estimate = asNumber(task.estimatedHours);
    const logged = task.timeLogs.reduce((sum, log) => sum + asNumber(log.hours), 0);
    const remainingByHours = Math.max(0, estimate - logged);
    const remainingByProgress = Math.max(0, estimate * (1 - Math.min(100, task.aiProgress || 0) / 100));
    const remaining = Math.max(remainingByHours, remainingByProgress);
    workloadHours.set(task.assignedToId, (workloadHours.get(task.assignedToId) || 0) + remaining);
  });

  const startedAt = Date.now();
  const generated = await generateProjectPlanBlueprint({ organization: project.organization, project, requirements });
  const scheduled = schedulePlan({
    blueprint: generated.blueprint,
    organization: project.organization,
    project,
    requirements,
    users,
    workloadHours,
  });
  if (generated.degradedReason) scheduled.warnings.unshift(generated.degradedReason);
  const generationMs = Date.now() - startedAt;

  const plan = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE`;
    const latest = await transaction.projectPlan.aggregate({
      _max: { version: true },
      where: { projectId },
    });
    await transaction.projectPlan.updateMany({
      data: { status: "SUPERSEDED" },
      where: { projectId, status: "DRAFT" },
    });
    const created = await transaction.projectPlan.create({
      data: {
        assumptions: scheduled.assumptions,
        createdById: currentUser.id,
        generationMs,
        manualBaselineMinutes: options.manualBaselineMinutes || null,
        metrics: scheduled.metrics,
        model: generated.model,
        organizationId: currentUser.organizationId,
        projectId,
        requirementsSnapshot: requirements.map((requirement) => ({
          acceptanceCriteria: requirement.acceptanceCriteria || "",
          description: requirement.description,
          key: requirement.key,
          priority: String(requirement.priority).toLowerCase(),
          title: requirement.title,
        })),
        summary: scheduled.summary,
        version: (latest._max.version || 0) + 1,
        warnings: scheduled.warnings,
        milestones: {
          create: scheduled.milestones.map((milestone) => ({
            key: milestone.key,
            outcome: milestone.outcome,
            position: milestone.position,
            targetDate: milestone.targetDate,
            title: milestone.title,
          })),
        },
        tasks: {
          create: scheduled.tasks.map((task) => ({
            acceptanceCriteria: task.acceptanceCriteria,
            category: task.category,
            confidence: task.confidence,
            dependencyKeys: task.dependencyKeys,
            description: task.description,
            estimatedHours: task.estimatedHours,
            key: task.key,
            milestoneKey: task.milestoneKey || null,
            position: task.position,
            priority: task.priority,
            projectWeight: task.projectWeight,
            requirementKeys: task.requirementKeys,
            requiredSkills: task.requiredSkills,
            riskLevel: task.riskLevel,
            scheduledEnd: task.scheduledEnd,
            scheduledStart: task.scheduledStart,
            suggestedAssigneeId: task.suggestedAssigneeId,
            suggestionReason: task.suggestionReason,
            title: task.title,
          })),
        },
      },
      include: planInclude,
    });
    await transaction.auditLog.create({
      data: {
        action: "PLAN_GENERATED",
        actorId: currentUser.id,
        entityId: projectId,
        entityType: "PROJECT",
        metadata: { model: generated.model, planId: created.id, version: created.version },
        organizationId: currentUser.organizationId,
        summary: `Generated delivery plan v${created.version} for ${project.name}`,
      },
    });
    return created;
  });
  return serializePlan(plan);
};

const listPlans = async (currentUser, projectId) => {
  await getProject(currentUser, projectId);
  const plans = await prisma.projectPlan.findMany({
    include: planInclude,
    orderBy: { version: "desc" },
    where: { organizationId: currentUser.organizationId, projectId },
  });
  return plans.map(serializePlan);
};

const getPlanRecord = async (currentUser, projectId, planId) => {
  await getProject(currentUser, projectId);
  const plan = await prisma.projectPlan.findFirst({
    include: planInclude,
    where: { id: planId, organizationId: currentUser.organizationId, projectId },
  });
  if (!plan) throw new ApiError(404, "Project plan not found.");
  return plan;
};

const approvePlan = async (currentUser, projectId, planId, options = {}) => {
  assertPlanningPermission(currentUser);
  const plan = await getPlanRecord(currentUser, projectId, planId);
  if (plan.status !== "DRAFT") throw new ApiError(409, "Only a draft plan can be approved.");
  const overrides = options.assignmentOverrides || {};
  const selectedIds = plan.tasks
    .map((task) => {
      if (Object.prototype.hasOwnProperty.call(overrides, task.key)) return overrides[task.key] || null;
      return options.useRecommendations ? task.suggestedAssigneeId : null;
    })
    .filter(Boolean);
  const validUsers = selectedIds.length
    ? await prisma.user.findMany({
        select: { id: true },
        where: { id: { in: selectedIds }, organizationId: currentUser.organizationId, status: "ACTIVE" },
      })
    : [];
  if (new Set(validUsers.map((user) => user.id)).size !== new Set(selectedIds).size) {
    throw new ApiError(400, "One or more approved assignees are not active workspace members.");
  }

  const reviewDurationSeconds = options.reviewDurationSeconds || Math.max(
    1,
    Math.round((Date.now() - plan.createdAt.getTime()) / 1000),
  );
  const outboxEventId = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE`;
    const existingApprovedPlan = await transaction.projectPlan.findFirst({
      select: { id: true, version: true },
      where: { id: { not: planId }, projectId, status: "APPROVED" },
    });
    if (existingApprovedPlan) {
      throw new ApiError(
        409,
        `Plan v${existingApprovedPlan.version} is already materialized. Reject this draft or create incremental tasks manually.`,
      );
    }
    const claimed = await transaction.projectPlan.updateMany({
      data: {
        approvedAt: new Date(),
        approvedById: currentUser.id,
        ...(!plan.manualBaselineMinutes && options.manualBaselineMinutes
          ? { manualBaselineMinutes: options.manualBaselineMinutes }
          : {}),
        reviewDurationSeconds,
        status: "APPROVED",
      },
      where: { id: planId, status: "DRAFT" },
    });
    if (claimed.count !== 1) throw new ApiError(409, "This plan was already reviewed.");

    const createdByKey = new Map();
    for (const item of plan.tasks) {
      const approvedAssigneeId = Object.prototype.hasOwnProperty.call(overrides, item.key)
        ? overrides[item.key] || null
        : options.useRecommendations
          ? item.suggestedAssigneeId
          : null;
      const task = await transaction.task.create({
        data: {
          assignedToId: approvedAssigneeId,
          category: item.category,
          confidence: item.confidence,
          createdById: currentUser.id,
          deadline: item.scheduledEnd,
          description: item.description,
          estimatedHours: item.estimatedHours,
          organizationId: currentUser.organizationId,
          priority: item.priority,
          projectId,
          projectWeight: item.projectWeight,
          requiredSkills: item.requiredSkills,
          riskLevel: item.riskLevel,
          source: "ai_plan",
          status: "NEW",
          successCriteria: item.acceptanceCriteria,
          title: item.title,
        },
      });
      createdByKey.set(item.key, task.id);
      await transaction.plannedTask.update({
        data: { approvedAssigneeId, materializedTaskId: task.id },
        where: { id: item.id },
      });
      if (approvedAssigneeId && approvedAssigneeId !== currentUser.id) {
        await transaction.notification.create({
          data: {
            actionUrl: `/tasks/${task.id}`,
            actorId: currentUser.id,
            entityId: task.id,
            entityType: "task",
            message: `${currentUser.fullName} approved and assigned "${task.title}" from project plan v${plan.version}.`,
            organizationId: currentUser.organizationId,
            recipientId: approvedAssigneeId,
            title: "Planned task assigned",
            type: "TASK_ASSIGNED",
          },
        });
      }
    }
    const dependencies = plan.tasks.flatMap((item) =>
      item.dependencyKeys.flatMap((dependencyKey) => {
        const taskId = createdByKey.get(item.key);
        const dependsOnTaskId = createdByKey.get(dependencyKey);
        return taskId && dependsOnTaskId ? [{ dependsOnTaskId, taskId }] : [];
      }),
    );
    if (dependencies.length) await transaction.taskDependency.createMany({ data: dependencies, skipDuplicates: true });
    await transaction.project.update({ data: { version: { increment: 1 } }, where: { id: projectId } });
    await transaction.auditLog.create({
      data: {
        action: "PLAN_APPROVED",
        actorId: currentUser.id,
        entityId: projectId,
        entityType: "PROJECT",
        metadata: { planId, taskCount: plan.tasks.length, version: plan.version },
        organizationId: currentUser.organizationId,
        summary: `Approved project plan v${plan.version} and created ${plan.tasks.length} tasks`,
      },
    });
    const outboxEvent = await transaction.outboxEvent.create({
      data: {
        aggregateId: projectId,
        aggregateType: "PROJECT",
        organizationId: currentUser.organizationId,
        payload: {
          planId,
          push: {
            actionUrl: `/projects/${projectId}/planner`,
            entityId: projectId,
            entityType: "project",
            message: `${currentUser.fullName} approved ${plan.tasks.length} planned tasks for ${plan.project.name}.`,
            title: "Project plan approved",
            type: "PROJECT_PLAN_APPROVED",
          },
          recipientIds: [...new Set(plan.tasks.map((item) => {
            if (Object.prototype.hasOwnProperty.call(overrides, item.key)) return overrides[item.key] || null;
            return options.useRecommendations ? item.suggestedAssigneeId : null;
          }).filter((id) => id && id !== currentUser.id))],
          taskCount: plan.tasks.length,
          version: plan.version,
        },
        topic: "project.plan.approved",
      },
    });
    return outboxEvent.id;
  });
  await safelyDeliverOutboxEvent(outboxEventId);
  return serializePlan(await getPlanRecord(currentUser, projectId, planId));
};

const rejectPlan = async (currentUser, projectId, planId, reason = "") => {
  assertPlanningPermission(currentUser);
  const plan = await getPlanRecord(currentUser, projectId, planId);
  if (plan.status !== "DRAFT") throw new ApiError(409, "Only a draft plan can be rejected.");
  await prisma.$transaction([
    prisma.projectPlan.update({ data: { rejectedAt: new Date(), status: "REJECTED" }, where: { id: planId } }),
    prisma.auditLog.create({
      data: {
        action: "PLAN_REJECTED",
        actorId: currentUser.id,
        entityId: projectId,
        entityType: "PROJECT",
        metadata: { planId, reason, version: plan.version },
        organizationId: currentUser.organizationId,
        summary: `Rejected project plan v${plan.version}`,
      },
    }),
  ]);
  return serializePlan(await getPlanRecord(currentUser, projectId, planId));
};

const evaluatePlan = async (currentUser, projectId, planId, notes = "") => {
  assertPlanningPermission(currentUser);
  const plan = await getPlanRecord(currentUser, projectId, planId);
  if (plan.status !== "APPROVED") throw new ApiError(409, "Approve the plan before evaluating delivery accuracy.");
  const taskIds = plan.tasks.map((task) => task.materializedTaskId).filter(Boolean);
  const tasks = await prisma.task.findMany({
    include: { timeLogs: true },
    where: { id: { in: taskIds }, organizationId: currentUser.organizationId },
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const completed = tasks.filter((task) => task.status === "COMPLETED");
  const effortErrors = [];
  let scheduleViolations = 0;
  let dependencyViolations = 0;
  let overrides = 0;

  for (const item of plan.tasks) {
    const task = byId.get(item.materializedTaskId);
    if (item.suggestedAssigneeId !== item.approvedAssigneeId) overrides += 1;
    if (!task) continue;
    const actualHours = task.timeLogs.reduce((sum, log) => sum + asNumber(log.hours), 0);
    if (task.status === "COMPLETED") {
      effortErrors.push(Math.abs(actualHours - asNumber(item.estimatedHours)));
      if (item.scheduledEnd && task.completedAt && task.completedAt > item.scheduledEnd) scheduleViolations += 1;
      for (const dependencyKey of item.dependencyKeys) {
        const dependencyItem = plan.tasks.find((candidate) => candidate.key === dependencyKey);
        const dependency = dependencyItem ? byId.get(dependencyItem.materializedTaskId) : null;
        if (!dependency?.completedAt || (task.completedAt && dependency.completedAt > task.completedAt)) {
          dependencyViolations += 1;
        }
      }
    }
  }

  const metrics = {
    completionRate: tasks.length ? round2((completed.length / tasks.length) * 100) : 0,
    dependencyViolations,
    effortMeanAbsoluteError: effortErrors.length
      ? round2(effortErrors.reduce((sum, value) => sum + value, 0) / effortErrors.length)
      : null,
    managerOverrideRate: plan.tasks.length ? round2((overrides / plan.tasks.length) * 100) : 0,
    generationSeconds: round2((plan.generationMs || 0) / 1000),
    planningReviewMinutes: round2((plan.reviewDurationSeconds || 0) / 60),
    planningTimeSavedMinutes: plan.manualBaselineMinutes
      ? round2(Math.max(0, plan.manualBaselineMinutes - (plan.reviewDurationSeconds || 0) / 60))
      : null,
    requirementCoverage: plan.metrics?.requirementCoverage || 0,
    scheduleViolations,
    taskCount: tasks.length,
  };
  const evaluation = await prisma.planEvaluation.create({ data: { metrics, notes: notes || null, planId } });
  return evaluation;
};

module.exports = {
  approvePlan,
  deriveRequirements,
  evaluatePlan,
  generatePlan,
  listPlans,
  rejectPlan,
  schedulePlan,
  serializePlan,
  topologicalTasks,
};
