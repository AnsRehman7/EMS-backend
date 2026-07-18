const prisma = require("../db/prisma");
const { generateJson, isGroqConfigured } = require("./groq.service");

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, Number(value) || 0));
const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value));

const round2 = (value) => Math.round(value * 100) / 100;

const calculateWeightedProjectProgress = (tasks = []) => {
  if (!tasks.length) return 0;

  const weightTotal = tasks.reduce((total, task) => total + toNumber(task.projectWeight), 0);
  const effectiveWeight = weightTotal > 0 ? weightTotal : tasks.length;
  const weightedProgress = tasks.reduce((total, task) => {
    const weight = weightTotal > 0 ? toNumber(task.projectWeight) : 1;
    const taskProgress = task.status === "COMPLETED" ? 100 : clamp(task.aiProgress);
    return total + weight * taskProgress;
  }, 0);

  return Math.round(weightedProgress / effectiveWeight);
};

const equalWeights = (tasks) => {
  if (!tasks.length) return [];

  const baseWeight = round2(100 / tasks.length);
  let assigned = 0;

  return tasks.map((task, index) => {
    const weight = index === tasks.length - 1 ? round2(100 - assigned) : baseWeight;
    assigned += weight;
    return { taskId: task.id, weight };
  });
};

const normalizeWeights = (tasks, weights = []) => {
  const rawByTaskId = new Map(weights.map((item) => [item.taskId, clamp(item.weight)]));
  const normalized = tasks.map((task) => ({
    taskId: task.id,
    weight: rawByTaskId.get(task.id) || 0,
  }));
  const total = normalized.reduce((sum, item) => sum + item.weight, 0);

  if (total <= 0) return equalWeights(tasks);

  let assigned = 0;
  return normalized.map((item, index) => {
    const weight = index === normalized.length - 1 ? round2(100 - assigned) : round2((item.weight / total) * 100);
    assigned += weight;
    return { taskId: item.taskId, weight };
  });
};

const buildWeightPrompt = (project, tasks) => `
You are a senior project manager. Analyze this project and assign each task a weightage percentage of the total project scope.

Rules:
- Return JSON only.
- The weights must sum to 100.
- Use each exact taskId.
- Weight by business impact, complexity, dependencies, risk, and success criteria.
- Do not invent task IDs.

JSON schema:
{
  "summary": "short explanation",
  "tasks": [
    { "taskId": "task id", "weight": 25 }
  ]
}

Project:
${JSON.stringify(
  {
    description: project.description,
    dueDate: project.dueDate,
    name: project.name,
    startDate: project.startDate,
  },
  null,
  2
)}

Tasks:
${JSON.stringify(
  tasks.map((task) => ({
    category: task.category,
    description: task.description,
    estimatedHours: toNumber(task.estimatedHours),
    status: task.status,
    successCriteria: task.successCriteria,
    taskId: task.id,
    title: task.title,
  })),
  null,
  2
)}
`;

const buildProgressPrompt = (task, latestComment) => `
You are a senior delivery reviewer. Estimate task completion progress from the task requirements, success criteria, time logs, and latest employee comment.

Rules:
- Return JSON only.
- progress must be an integer from 0 to 100.
- Do not mark 100 unless the comment and success criteria strongly indicate complete delivery.
- If the employee says some work remains, keep progress below 90.

JSON schema:
{
  "progress": 50,
  "summary": "short explanation of what is done and what remains"
}

Project:
${JSON.stringify(
  {
    description: task.project?.description,
    dueDate: task.project?.dueDate,
    name: task.project?.name,
  },
  null,
  2
)}

Task:
${JSON.stringify(
  {
    category: task.category,
    currentProgress: task.aiProgress,
    description: task.description,
    estimatedHours: toNumber(task.estimatedHours),
    latestComment,
    priority: task.priority,
    status: task.status,
    successCriteria: task.successCriteria,
    title: task.title,
    totalLoggedHours: (task.timeLogs || []).reduce((total, log) => total + toNumber(log.hours), 0),
    timeLogs: (task.timeLogs || []).map((log) => ({
      hours: toNumber(log.hours),
      loggedAt: log.loggedAt,
      note: log.note,
    })),
  },
  null,
  2
)}
`;

const fallbackProgress = (task, latestComment = "") => {
  if (task.status === "COMPLETED") return 100;

  const loggedHours = (task.timeLogs || []).reduce((total, log) => total + toNumber(log.hours), 0);
  const estimatedHours = toNumber(task.estimatedHours);
  const comment = String(latestComment || "").toLowerCase();
  const hourProgress = estimatedHours > 0 ? clamp((loggedHours / estimatedHours) * 100, 0, 95) : clamp(loggedHours * 10, 0, 80);

  if (comment.includes("remaining") || comment.includes("blocked") || comment.includes("pending")) {
    return Math.min(Math.round(hourProgress || 50), 85);
  }

  if (comment.includes("complete") || comment.includes("completed") || comment.includes("done") || comment.includes("delivered")) {
    return Math.max(Math.round(hourProgress), 85);
  }

  return Math.max(clamp(task.aiProgress), Math.round(hourProgress));
};

const updateProjectProgress = async (projectId, organizationId, summary = undefined) => {
  if (!projectId) return null;

  const project = await prisma.project.findFirst({
    include: {
      tasks: {
        select: {
          aiProgress: true,
          projectWeight: true,
          status: true,
        },
      },
    },
    where: {
      id: projectId,
      organizationId,
    },
  });

  if (!project) return null;

  const aiProgress = calculateWeightedProjectProgress(project.tasks);
  return prisma.project.update({
    data: {
      aiAnalyzedAt: new Date(),
      aiProgress,
      ...(summary ? { aiSummary: summary } : {}),
    },
    where: { id: project.id },
  });
};

const refreshProjectWeights = async (projectId, organizationId) => {
  const project = await prisma.project.findFirst({
    include: {
      tasks: {
        orderBy: { createdAt: "asc" },
      },
    },
    where: {
      id: projectId,
      organizationId,
    },
  });

  if (!project || project.tasks.length === 0) return null;

  let weights = equalWeights(project.tasks);
  let summary = "Equal weight fallback was used because Groq is not configured.";

  if (isGroqConfigured()) {
    try {
      const result = await generateJson(buildWeightPrompt(project, project.tasks));
      weights = normalizeWeights(project.tasks, result.tasks || []);
      summary = result.summary || "Groq analyzed task weightage for this project.";
    } catch (error) {
      console.warn("Groq project weight analysis failed:", error.message);
      summary = "Equal weight fallback was used because AI analysis failed.";
    }
  }

  await prisma.$transaction(
    weights.map((item) =>
      prisma.task.update({
        data: {
          aiAnalyzedAt: new Date(),
          projectWeight: item.weight,
        },
        where: { id: item.taskId },
      })
    )
  );

  return updateProjectProgress(projectId, organizationId, summary);
};

const analyzeTaskProgress = async ({ latestComment = "", organizationId, taskId, timeLogId = null }) => {
  const task = await prisma.task.findFirst({
    include: {
      project: true,
      timeLogs: {
        orderBy: { loggedAt: "desc" },
      },
    },
    where: {
      id: taskId,
      organizationId,
    },
  });

  if (!task) return null;

  let progress = fallbackProgress(task, latestComment);
  let summary = "Deterministic progress fallback was used because Groq is not configured.";

  if (isGroqConfigured()) {
    try {
      const result = await generateJson(buildProgressPrompt(task, latestComment));
      progress = clamp(result.progress);
      summary = result.summary || "Groq analyzed task progress from the latest work log.";
    } catch (error) {
      console.warn("Groq task progress analysis failed:", error.message);
      summary = "Deterministic progress fallback was used because AI analysis failed.";
    }
  }

  const roundedProgress = Math.round(progress);
  await prisma.task.update({
    data: {
      aiAnalyzedAt: new Date(),
      aiProgress: roundedProgress,
      aiSummary: summary,
    },
    where: { id: task.id },
  });

  if (timeLogId) {
    await prisma.timeLog.update({
      data: {
        aiProgressAfter: roundedProgress,
        analysisSummary: summary,
      },
      where: { id: timeLogId },
    });
  }

  await updateProjectProgress(task.projectId, organizationId);
  return { progress: roundedProgress, summary };
};

module.exports = {
  analyzeTaskProgress,
  calculateWeightedProjectProgress,
  refreshProjectWeights,
  updateProjectProgress,
};
