const ApiError = require("../utils/apiError");
const { generateJson, isLlmConfigured } = require("./llm.service");
const { hasPermission } = require("../utils/permissions");
const { runReports } = require("./assistantReport.service");
const {
  normalize,
  projectCandidate,
  resolveEntity,
  taskCandidate,
  userCandidate,
} = require("./assistantResolver.service");
const { safelyRecordAudit } = require("./audit.service");
const projectService = require("./project.service");
const taskService = require("./task.service");
const {
  buildPrompt,
  loadContext,
  MAX_ACTIONS,
  normalizeHistory,
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
 * Tappable answers for a name that was ambiguous or not found. Each carries the message
 * the panel sends on the person's behalf; with the conversation history the model then
 * re-plans the original request using the chosen name.
 */
const choicesFor = (typed, candidates) =>
  candidates.slice(0, 4).map((candidate) => ({
    label: candidate.name + (candidate.email ? " · " + candidate.email : ""),
    prompt: 'I meant "' + candidate.name + '" (for "' + typed + '"). Please go ahead with my request.',
  }));

/**
 * Resolves one name and records the outcome on the action: the id and label on success,
 * otherwise an issue that blocks the action and choices the person can pick from.
 */
const resolveInto = (resolved, { candidates, idKey, kind, labelKey, query, said = "", typed }) => {
  let match = resolveEntity(query, candidates);
  let shown = query;

  // The model maps what was typed onto a listed name, which is what fixes "logn page".
  // It will also "helpfully" turn "ahmed" into one particular Ahmed. So the person's own
  // words are resolved too, and when they fit several records the model's pick is
  // overruled by a question - unless the person has typed that full name themselves.
  if (
    match.status === "resolved" &&
    typed &&
    normalize(typed) !== normalize(query) &&
    !said.includes(normalize(match.match.name))
  ) {
    const literal = resolveEntity(typed, candidates);
    if (literal.status === "ambiguous" && literal.candidates.some((candidate) => candidate.id === match.match.id)) {
      match = literal;
      shown = typed;
    } else if (literal.status === "resolved" && literal.match.id !== match.match.id) {
      match = { candidates: [literal.match, match.match], status: "ambiguous" };
      shown = typed;
    }
  }

  if (match.status === "resolved") {
    resolved[idKey] = match.match.id;
    resolved[labelKey] = match.match.name;
    return match.match;
  }
  if (match.status === "ambiguous") {
    resolved.issues.push('"' + shown + '" matches several ' + kind.plural + ": " + describeCandidates(match.candidates));
    resolved.choices.push(...choicesFor(shown, match.candidates));
  } else {
    resolved.issues.push(
      "No " + kind.singular + ' called "' + query + '" was found' +
        (match.suggestions.length ? ". Did you mean " + describeCandidates(match.suggestions) + "?" : "."),
    );
    resolved.choices.push(...choicesFor(shown, match.suggestions));
  }
  return null;
};

const KINDS = {
  person: { plural: "people", singular: "active team member" },
  project: { plural: "projects", singular: "project" },
  task: { plural: "tasks", singular: "task" },
};

/**
 * Resolves the people, projects and tasks named in a plan.
 *
 * A task may reference a project being created earlier in the same plan, so new projects
 * are matched by name before existing ones. Anything unresolved becomes a blocking issue
 * on that action rather than a silent drop - the user is told exactly what was not found
 * and offered the closest matches to pick from.
 *
 * Tasks are matched against the caller's own task scope from the context snapshot,
 * completed ones included so "reopen the login task" works; open tasks win a tie.
 */
const resolvePlan = async (currentUser, plan, context, conversation = {}) => {
  // Everything the person has typed in this exchange, for the full-name check in resolveInto.
  const said = normalize(
    [
      ...(conversation.history || []).filter((turn) => turn.role === "user").map((turn) => turn.text),
      conversation.message || "",
    ].join(" "),
  );
  const userCandidates = context.users.map(userCandidate);
  const projectCandidates = context.projects.map(projectCandidate);
  const taskCandidates = context.tasks.map(taskCandidate);

  const newProjectNames = plan.actions
    .filter((action) => action.type === "create_project")
    .map((action) => action.name);

  return plan.actions.map((action, index) => {
    const resolved = { ...action, choices: [], index, issues: [] };

    if (!hasPermission(currentUser, PERMISSION_FOR_ACTION[action.type])) {
      resolved.issues.push("You do not have permission to do this.");
    }

    if (action.type !== "create_project") {
      if (action.project) {
        // A project created earlier in this same plan has no id yet, so it is carried as
        // a name and linked during execution.
        const pendingName = newProjectNames.find(
          (name) => name.trim().toLowerCase() === action.project.trim().toLowerCase(),
        );

        if (pendingName) {
          if (action.type === "update_project") {
            // The project does not exist yet, so set its details at creation instead.
            resolved.issues.push('"' + action.project + '" is being created in this same request, so it cannot be updated.');
          }
          resolved.projectId = null;
          resolved.pendingProjectName = pendingName;
          resolved.projectLabel = pendingName + " (new)";
        } else {
          resolveInto(resolved, {
            candidates: projectCandidates,
            idKey: "projectId",
            kind: KINDS.project,
            labelKey: "projectLabel",
            query: action.project,
            said,
            typed: action.typed?.project,
          });
        }
      } else if (action.type === "create_task") {
        resolved.issues.push("No project was given for this task. Which project should it go in?");
      } else if (action.type === "update_project") {
        resolved.issues.push("No project was named to update.");
      }
      // An update or assignment may name the task alone; the project only narrows the search.
    }

    if (action.assignee) {
      resolveInto(resolved, {
        candidates: userCandidates,
        idKey: "assignedToId",
        kind: KINDS.person,
        labelKey: "assigneeLabel",
        query: action.assignee,
        said,
        typed: action.typed?.assignee,
      });
    }

    if (action.type === "update_project" && action.owner) {
      resolveInto(resolved, {
        candidates: userCandidates,
        idKey: "ownerId",
        kind: KINDS.person,
        labelKey: "ownerLabel",
        query: action.owner,
        said,
        typed: action.typed?.owner,
      });
    }

    if (action.type === "assign_task" || action.type === "update_task") {
      // A project the model filled in on its own is its guess at which task was meant, so
      // it must not narrow the search: only a project the person named does.
      const typed = action.typed || {};
      const personNamedProject = Boolean(typed.project) || !Object.keys(typed).length;
      const inProject =
        resolved.projectId && personNamedProject
          ? taskCandidates.filter((task) => task.projectId === resolved.projectId)
          : [];
      // The project narrows the search, but when nothing in it matches - the model or the
      // person named the wrong project - the whole task list is still searched.
      const pool =
        inProject.length && resolveEntity(action.task, inProject).status !== "unknown" ? inProject : taskCandidates;
      resolveInto(resolved, {
        candidates: pool,
        idKey: "taskId",
        kind: KINDS.task,
        labelKey: "taskLabel",
        query: action.task,
        said,
        typed: action.typed?.task,
      });
    }

    return { ...resolved, executable: resolved.issues.length === 0 };
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

  if (action.type === "update_project") {
    const changes = [];
    if (action.name) changes.push("rename to " + action.name);
    if (action.ownerLabel || action.owner) changes.push("owner " + (action.ownerLabel || action.owner));
    if (action.startDate) changes.push("starts " + action.startDate);
    if (action.dueDate) changes.push("due " + action.dueDate);
    if (action.priority) changes.push(action.priority + " priority");
    if (action.status) changes.push("status " + action.status);
    if (action.description) changes.push("new description");
    return "Update project " + (action.projectLabel || action.project) + " · " + changes.join(" · ");
  }

  if (action.type === "update_task") {
    const changes = [];
    if (action.newTitle) changes.push("rename to " + action.newTitle);
    if (action.assigneeLabel || action.assignee) {
      changes.push("assign to " + (action.assigneeLabel || action.assignee));
    }
    if (action.deadline) changes.push("due " + action.deadline);
    if (action.priority) changes.push(action.priority + " priority");
    if (action.status) changes.push("status " + action.status.replace(/_/g, " "));
    if (action.estimatedHours !== null && action.estimatedHours !== undefined) {
      changes.push(action.estimatedHours + "h estimated");
    }
    if (action.description) changes.push("new description");
    return "Update " + (action.taskLabel || action.task) + " · " + changes.join(" · ");
  }

  return "Assign " + (action.taskLabel || action.task) + " to " + (action.assigneeLabel || action.assignee);
};

/* -------------------------------------------------------------------------- */
/* Interpret                                                                   */
/* -------------------------------------------------------------------------- */

/** What the panel shows when the model understood nothing it could act on or answer. */
const FALLBACK_REPLY =
  "I'm not sure I followed. I can answer questions about your projects, tasks and team, " +
  'or make changes - for example "How many tasks are completed in Website Redesign?" or ' +
  '"Assign the login task to Sara".';

const NOTHING_TO_CHANGE_REPLY =
  "I understood you want to change something, but not which record or what to change. " +
  'Name the task or project and the change - for example "Mark the login page task as done".';

const interpret = async (currentUser, message, history = []) => {
  if (!isLlmConfigured()) {
    throw new ApiError(503, "The assistant is unavailable because no language model is configured.");
  }

  const context = await loadContext(currentUser);
  const conversation = { history: normalizeHistory(history), message };
  const raw = await generateJson(buildPrompt(message, context, conversation.history), { temperature: 0.1 });
  const plan = normalizePlan(raw);

  // Questions are answered with numbers the database counted, not numbers the model wrote.
  const report = plan.queries.length
    ? await runReports(currentUser, plan.queries, context)
    : { choices: [], items: [], text: "" };

  if (!plan.actions.length) {
    if (report.text) {
      return {
        actions: [],
        choices: report.choices,
        items: report.items,
        planToken: null,
        reply: report.text,
        status: report.choices.length ? "clarify" : "answered",
      };
    }
    if (plan.needsClarification && (plan.question || plan.reply)) {
      return { actions: [], choices: [], items: [], planToken: null, reply: plan.question || plan.reply, status: "clarify" };
    }
    if (plan.dropped) {
      return { actions: [], choices: [], items: [], planToken: null, reply: NOTHING_TO_CHANGE_REPLY, status: "clarify" };
    }
    return { actions: [], choices: [], items: [], planToken: null, reply: plan.reply || FALLBACK_REPLY, status: "answered" };
  }

  const resolved = await resolvePlan(currentUser, plan, context, conversation);
  const executable = resolved.filter((action) => action.executable);

  const actions = resolved.map((action) => ({
    choices: action.choices,
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
        actions: executable.map(({ choices, issues, typed, ...action }) => action),
        expiresAt: Date.now() + PLAN_TTL_MS,
        organizationId: currentUser.organizationId,
        userId: currentUser.id,
      })
    : null;

  // The model's reply describes the plan as it imagined it. Once resolution has blocked a
  // step - an ambiguous name, a missing permission - that description is no longer true.
  const blockedCount = resolved.length - executable.length;
  const lead = !blockedCount
    ? plan.reply || "Here is what I will do. Review it and press Apply."
    : executable.length
      ? "I can do part of this. Review what is ready, and answer the notes below for the rest."
      : "I need a little more before I can do this - see the notes below.";

  return {
    actions,
    choices: report.choices,
    items: report.items,
    planToken,
    reply: [report.text, lead].filter(Boolean).join("\n"),
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

      if (action.type === "update_project") {
        const patch = {};
        if (action.name) patch.name = action.name;
        if (action.description) patch.description = action.description;
        if (action.dueDate) patch.dueDate = action.dueDate;
        if (action.priority) patch.priority = action.priority;
        if (action.status) patch.status = action.status;
        if (action.ownerId) patch.ownerId = action.ownerId;
        if (action.startDate) patch.startDate = action.startDate;

        const project = await projectService.updateProject(action.projectId, currentUser, patch);
        results.push({
          id: project.id,
          label: "Updated project " + project.name,
          status: "done",
          type: action.type,
        });
        continue;
      }

      if (action.type === "update_task") {
        // Only the fields the user asked to change are sent, so nothing else is disturbed.
        const patch = {};
        if (action.deadline) patch.deadline = action.deadline;
        if (action.priority) patch.priority = action.priority;
        if (action.status) patch.status = action.status;
        if (action.estimatedHours !== null && action.estimatedHours !== undefined) {
          patch.estimatedHours = action.estimatedHours;
        }
        if (action.newTitle) patch.title = action.newTitle;
        if (action.description) patch.description = action.description;
        if (action.assignedToId) patch.assignedToId = action.assignedToId;

        const updated = await taskService.updateTask(action.taskId, currentUser, patch);
        results.push({ id: updated.id, label: "Updated " + updated.title, status: "done", type: action.type });
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
