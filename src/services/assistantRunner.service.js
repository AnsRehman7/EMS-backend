const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { generateJson, isLlmConfigured } = require("./llm.service");
const { hasPermission } = require("../utils/permissions");
const { projectCandidate, resolveEntity, userCandidate } = require("./assistantResolver.service");
const { safelyRecordAudit } = require("./audit.service");
const projectService = require("./project.service");
const taskService = require("./task.service");
const {
  buildPrompt,
  loadContext,
  MAX_ACTIONS,
  normalizePlan,
  PERMISSION_FOR_ACTION,
  PLAN_TTL_MS,
  signPlan,
  verifyPlan,
} = require("./assistant.service");

/**
 * Interpret and execute phases of the workspace assistant.
 *
 * Nothing in here trusts the model's output. Names are resolved against real rows by the
 * deterministic matcher, permissions are checked per action against the caller, and only
 * actions that survive both are signed into an executable plan.
 */

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

const describeCandidates = (candidates) =>
  candidates
    .slice(0, 4)
    .map((candidate) => candidate.name + (candidate.email ? " (" + candidate.email + ")" : ""))
    .join(", ");

/**
 * Resolves the people and projects named in a plan.
 *
 * A task may reference a project being created earlier in the same plan, so new projects
 * are matched by name before existing ones. Anything unresolved becomes a blocking issue
 * on that action rather than a silent drop - the user is told exactly what was not found.
 */
const resolvePlan = async (currentUser, plan, context) => {
  const userCandidates = context.users.map(userCandidate);
  const projectCandidates = context.projects.map(projectCandidate);

  const newProjectNames = plan.actions
    .filter((action) => action.type === "create_project")
    .map((action) => action.name);

  // Tasks are only looked up when an assign_task action actually needs one.
  const needsTaskLookup = plan.actions.some((action) => action.type === "assign_task");
  const taskCandidates = needsTaskLookup
    ? (
        await prisma.task.findMany({
          orderBy: { updatedAt: "desc" },
          select: { id: true, projectId: true, title: true },
          take: 300,
          where: {
            deletedAt: null,
            organizationId: currentUser.organizationId,
            status: { not: "COMPLETED" },
          },
        })
      ).map((task) => ({ id: task.id, labels: [task.title], name: task.title, projectId: task.projectId }))
    : [];

  return plan.actions.map((action, index) => {
    const issues = [];
    const resolved = { ...action, index };

    if (!hasPermission(currentUser, PERMISSION_FOR_ACTION[action.type])) {
      issues.push("You do not have permission to do this.");
    }

    if (action.type === "create_task" || action.type === "assign_task") {
      if (action.project) {
        // A project created earlier in this same plan has no id yet, so it is carried as
        // a name and linked during execution.
        const pendingName = newProjectNames.find(
          (name) => name.trim().toLowerCase() === action.project.trim().toLowerCase(),
        );

        if (pendingName) {
          resolved.projectId = null;
          resolved.pendingProjectName = pendingName;
          resolved.projectLabel = pendingName + " (new)";
        } else {
          const match = resolveEntity(action.project, projectCandidates);
          if (match.status === "resolved") {
            resolved.projectId = match.match.id;
            resolved.projectLabel = match.match.name;
          } else if (match.status === "ambiguous") {
            issues.push('"' + action.project + '" matches several projects: ' + describeCandidates(match.candidates));
          } else {
            issues.push('No project called "' + action.project + '" exists.');
          }
        }
      } else if (action.type === "create_task") {
        issues.push("No project was given for this task.");
      }
    }

    if (action.assignee) {
      const match = resolveEntity(action.assignee, userCandidates);
      if (match.status === "resolved") {
        resolved.assignedToId = match.match.id;
        resolved.assigneeLabel = match.match.name;
      } else if (match.status === "ambiguous") {
        issues.push('"' + action.assignee + '" matches several people: ' + describeCandidates(match.candidates));
      } else {
        issues.push('No active team member called "' + action.assignee + '" was found.');
      }
    }

    if (action.type === "assign_task") {
      const pool = resolved.projectId
        ? taskCandidates.filter((task) => task.projectId === resolved.projectId)
        : taskCandidates;
      const match = resolveEntity(action.task, pool);
      if (match.status === "resolved") {
        resolved.taskId = match.match.id;
        resolved.taskLabel = match.match.name;
      } else if (match.status === "ambiguous") {
        issues.push('"' + action.task + '" matches several tasks: ' + describeCandidates(match.candidates));
      } else {
        issues.push('No open task called "' + action.task + '" was found.');
      }
    }

    return { ...resolved, issues, executable: issues.length === 0 };
  });
};

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

/** One human-readable line per action, so the user confirms meaning rather than JSON. */
const describeAction = (action) => {
  if (action.type === "create_project") {
    const parts = ["Create project " + action.name];
    if (action.dueDate) parts.push("due " + action.dueDate);
    if (action.priority !== "normal") parts.push(action.priority + " priority");
    return parts.join(" · ");
  }

  if (action.type === "create_task") {
    const parts = ["Create task " + action.title];
    if (action.projectLabel) parts.push("in " + action.projectLabel);
    if (action.assigneeLabel) parts.push("for " + action.assigneeLabel);
    else parts.push("unassigned");
    if (action.deadline) parts.push("due " + action.deadline);
    return parts.join(" · ");
  }

  return "Assign " + (action.taskLabel || action.task) + " to " + (action.assigneeLabel || action.assignee);
};

/* -------------------------------------------------------------------------- */
/* Interpret                                                                   */
/* -------------------------------------------------------------------------- */

const interpret = async (currentUser, message) => {
  if (!isLlmConfigured()) {
    throw new ApiError(503, "The assistant is unavailable because no language model is configured.");
  }

  const context = await loadContext(currentUser);
  const raw = await generateJson(buildPrompt(message, context), { temperature: 0.1 });
  const plan = normalizePlan(raw);

  if (plan.needsClarification && plan.question) {
    return { actions: [], planToken: null, reply: plan.question, status: "clarify" };
  }

  if (!plan.actions.length) {
    return { actions: [], planToken: null, reply: plan.reply, status: "answered" };
  }

  const resolved = await resolvePlan(currentUser, plan, context);
  const executable = resolved.filter((action) => action.executable);

  const actions = resolved.map((action) => ({
    description: describeAction(action),
    executable: action.executable,
    index: action.index,
    issues: action.issues,
    type: action.type,
  }));

  // Only the actions that survived resolution and permission checks are signed. An action
  // the user was shown as blocked cannot be executed even if the token is replayed.
  const planToken = executable.length
    ? signPlan({
        actions: executable,
        expiresAt: Date.now() + PLAN_TTL_MS,
        organizationId: currentUser.organizationId,
        userId: currentUser.id,
      })
    : null;

  return {
    actions,
    planToken,
    reply: plan.reply,
    status: executable.length ? "preview" : "blocked",
  };
};

/* -------------------------------------------------------------------------- */
/* Execute                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs a confirmed plan.
 *
 * Actions run in order through the ordinary services, so each one re-checks permissions
 * and tenancy on its own. They are not wrapped in a single database transaction: the
 * project and task services own their own transactions and reusing them is worth more
 * than atomicity across the batch. A failure therefore stops the run and reports exactly
 * what was created before it, rather than silently leaving a half-built project.
 */
const execute = async (currentUser, planToken) => {
  const payload = verifyPlan(planToken, currentUser);
  const actions = Array.isArray(payload.actions) ? payload.actions.slice(0, MAX_ACTIONS) : [];

  if (!actions.length) throw new ApiError(400, "That plan has nothing to run.");

  const createdProjectsByName = new Map();
  const results = [];

  for (const action of actions) {
    try {
      if (action.type === "create_project") {
        const project = await projectService.createProject(currentUser, {
          description: action.description || undefined,
          dueDate: action.dueDate || undefined,
          name: action.name,
          priority: action.priority,
        });
        createdProjectsByName.set(action.name.trim().toLowerCase(), project.id);
        results.push({ id: project.id, label: "Created project " + project.name, status: "done", type: action.type });
        continue;
      }

      if (action.type === "create_task") {
        const projectId =
          action.projectId ||
          createdProjectsByName.get(String(action.pendingProjectName || "").trim().toLowerCase());

        if (!projectId) {
          results.push({ label: "Skipped task " + action.title, reason: "Its project was not created.", status: "failed", type: action.type });
          continue;
        }

        const task = await taskService.createTask(currentUser, {
          assignedToId: action.assignedToId || null,
          category: action.category,
          deadline: action.deadline || undefined,
          description: action.description || action.title,
          estimatedHours: action.estimatedHours === null ? undefined : action.estimatedHours,
          priority: action.priority,
          projectId,
          title: action.title,
        });
        results.push({ id: task.id, label: "Created task " + task.title, status: "done", type: action.type });
        continue;
      }

      const task = await taskService.updateTask(action.taskId, currentUser, {
        assignedToId: action.assignedToId,
      });
      results.push({ id: task.id, label: "Assigned " + task.title, status: "done", type: action.type });
    } catch (error) {
      results.push({
        label: describeAction(action),
        reason: error.message || "That step failed.",
        status: "failed",
        type: action.type,
      });
      break;
    }
  }

  const completed = results.filter((result) => result.status === "done").length;

  await safelyRecordAudit({
    action: "CREATED",
    actor: currentUser,
    entityId: currentUser.id,
    entityType: "WORKSPACE",
    metadata: { completed, requested: actions.length },
    summary: "Ran " + completed + " assistant action(s)",
  });

  return {
    results,
    summary:
      completed === actions.length
        ? "Done. " + completed + " change" + (completed === 1 ? "" : "s") + " applied."
        : "Applied " + completed + " of " + actions.length + " changes.",
  };
};

module.exports = {
  describeAction,
  execute,
  interpret,
  resolvePlan,
};
