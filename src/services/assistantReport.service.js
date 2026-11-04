const prisma = require("../db/prisma");
const { projectCandidate, resolveEntity, userCandidate } = require("./assistantResolver.service");
const { startOfDayUtc, statusLabel, taskScopeWhere } = require("./assistant.service");

/**
 * Read-only answers for the workspace assistant.
 *
 * The model decides WHAT is being asked ("completed tasks in Website Redesign") and emits
 * a task_report query; this file decides the answer. Counting is done by the database,
 * never by the model, because a model reading a list of rows miscounts them often enough
 * to matter. Names are resolved by the same deterministic matcher the actions use, and
 * every query is ANDed with the caller's own visibility scope, so a report can never
 * reveal a task the person could not already open in the app.
 */

const LIST_LIMIT = 10;

/** Below this many matches the tasks are listed even when only a count was asked for. */
const AUTO_LIST_MAX = 5;

const STATUS_ADJECTIVES = {
  active: "active",
  blocked: "blocked",
  completed: "completed",
  in_progress: "in-progress",
  new: "not-started",
  open: "open",
};

const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");

/**
 * Builds the Prisma filter for a resolved report. Pure, so the tenancy and visibility
 * guarantees are unit tested: the scope is always ANDed in, never merged, so a filter
 * such as "unassigned" cannot overwrite an employee's own-tasks-only restriction.
 */
const buildTaskReportWhere = (report, scope, today) => {
  const filters = {};

  if (report.projectId) filters.projectId = report.projectId;
  if (report.unassigned) filters.assignedToId = null;
  else if (report.assignedToId) filters.assignedToId = report.assignedToId;

  if (report.status === "open") filters.status = { not: "COMPLETED" };
  else if (report.status) filters.status = report.status.toUpperCase();

  if (report.priority) filters.priority = report.priority.toUpperCase();

  const deadline = {};
  // A completed task cannot be overdue, so "overdue" is ignored once completion is asked for.
  if (report.overdue && report.status !== "completed") {
    deadline.lt = startOfDayUtc(today);
    if (!filters.status) filters.status = { not: "COMPLETED" };
  }
  if (report.dueFrom) deadline.gte = startOfDayUtc(report.dueFrom);
  if (report.dueTo) deadline.lte = startOfDayUtc(report.dueTo);
  if (Object.keys(deadline).length) filters.deadline = deadline;

  return { AND: [scope, filters] };
};

/** "3 overdue high-priority open tasks in Website Redesign assigned to Sara Khan". */
const describeSubject = (report, count) => {
  const adjectives = [];
  if (report.overdue && report.status !== "completed") adjectives.push("overdue");
  if (report.priority) adjectives.push(report.priority + "-priority");
  if (report.status && report.status !== "open") adjectives.push(STATUS_ADJECTIVES[report.status]);
  else if (report.status === "open" && !report.overdue) adjectives.push("open");

  const qualifiers = [];
  if (report.projectLabel) qualifiers.push("in " + report.projectLabel);
  if (report.unassigned) qualifiers.push("with no assignee");
  else if (report.assigneeLabel) qualifiers.push("assigned to " + report.assigneeLabel);
  if (report.dueFrom && report.dueTo) qualifiers.push("due " + report.dueFrom + " to " + report.dueTo);
  else if (report.dueTo) qualifiers.push("due by " + report.dueTo);
  else if (report.dueFrom) qualifiers.push("due from " + report.dueFrom);

  return [count, ...adjectives, count === 1 ? "task" : "tasks", ...qualifiers].join(" ");
};

const BREAKDOWN_ORDER = [
  ["COMPLETED", "completed"],
  ["IN_PROGRESS", "in progress"],
  ["ACTIVE", "active"],
  ["BLOCKED", "blocked"],
  ["NEW", "not started"],
];

/**
 * Turns the numbers into a sentence. Pure; `counts` maps a stored status to its count.
 * A breakdown is only added when the question did not already pin the status down.
 */
const formatTaskReport = ({ counts, overdue, report, restricted, total }) => {
  if (!total) return "There are no " + describeSubject(report, "").trim() + ".";

  let text = "There " + (total === 1 ? "is " : "are ") + describeSubject(report, total) + ".";

  if (!report.status) {
    const parts = BREAKDOWN_ORDER.filter(([status]) => counts[status]).map(
      ([status, label]) => counts[status] + " " + label,
    );
    if (parts.length > 1) text += " " + parts.join(", ") + ".";
  }
  if (overdue && !report.overdue && report.status !== "completed") {
    text += " " + plural(overdue, "task") + (overdue === 1 ? " is" : " are") + " overdue.";
  }
  if (restricted) text += " (Counting only tasks assigned to you.)";

  return text;
};

/**
 * Words a grouped report: "Open tasks by person: Ahmed Raza 5, Sara Khan 3." Pure;
 * `groups` is [{ label, count }] already sorted, largest first.
 */
const formatGroupedReport = ({ groups, report, restricted }) => {
  const subject = describeSubject({ ...report, assigneeLabel: "", projectLabel: "" }, "").trim();
  const heading = subject.charAt(0).toUpperCase() + subject.slice(1) + " by " + (report.groupBy === "project" ? "project" : "person");
  const scope = [report.projectLabel && "in " + report.projectLabel, report.assigneeLabel && "for " + report.assigneeLabel]
    .filter(Boolean)
    .join(" ");

  if (!groups.length) return "There are no " + subject + (scope ? " " + scope : "") + ".";

  let text = heading + (scope ? " " + scope : "") + ": " + groups.map((group) => group.label + " " + group.count).join(", ") + ".";
  if (restricted) text += " (Counting only tasks assigned to you.)";
  return text;
};

/** Runs a report broken down by person or project, naming each group from the snapshot. */
const runGroupedReport = async (report, where, context, restricted) => {
  const key = report.groupBy === "project" ? "projectId" : "assignedToId";
  const names = new Map(
    report.groupBy === "project"
      ? context.projects.map((project) => [project.id, project.name])
      : context.users.map((user) => [user.id, user.name]),
  );
  const rows = await prisma.task.groupBy({ _count: { _all: true }, by: [key], where });
  const groups = rows
    .map((row) => ({
      count: row._count._all,
      label: names.get(row[key]) || (row[key] ? "Others" : report.groupBy === "project" ? "No project" : "Unassigned"),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    choices: [],
    items: [],
    text: formatGroupedReport({ groups: groups.slice(0, 15), report, restricted }),
  };
};

/** One line per listed task, for the panel to render under the answer. */
const formatTaskItem = (task, today) => {
  const parts = [task.project?.name || "No project", task.assignedTo?.fullName || "Unassigned", statusLabel(task.status)];
  if (task.deadline) {
    const due = new Date(task.deadline).toISOString().slice(0, 10);
    parts.push((task.status !== "COMPLETED" && due < today ? "overdue since " : "due ") + due);
  }
  return { detail: parts.join(" · "), title: task.title };
};

/** Turns an unresolved name into choices the person can tap instead of retyping. */
const choicesFor = (typed, candidates) =>
  candidates.slice(0, 4).map((candidate) => ({
    label: candidate.name + (candidate.email ? " · " + candidate.email : ""),
    prompt: 'I meant "' + candidate.name + '" (for "' + typed + '"). Please answer my question again.',
  }));

/**
 * Resolves the names in one query. Returns either the resolved report or a message
 * explaining which name did not match, with choices where there are near misses.
 */
const resolveReport = (query, context, currentUser) => {
  const report = { ...query };

  if (query.project) {
    const match = resolveEntity(query.project, context.projects.map(projectCandidate));
    if (match.status === "ambiguous") {
      return { choices: choicesFor(query.project, match.candidates), text: '"' + query.project + '" matches more than one project. Which one?' };
    }
    if (match.status === "unknown") {
      return {
        choices: choicesFor(query.project, match.suggestions),
        text: 'I could not find a project called "' + query.project + '"' + (match.suggestions.length ? ". Did you mean one of these?" : "."),
      };
    }
    report.projectId = match.match.id;
    report.projectLabel = match.match.name;
  }

  if (query.assignee && !query.unassigned) {
    if (["me", "myself", "i", "mine", "my"].includes(query.assignee.trim().toLowerCase())) {
      report.assignedToId = currentUser.id;
      report.assigneeLabel = "you";
    } else {
      const match = resolveEntity(query.assignee, context.users.map(userCandidate));
      if (match.status === "ambiguous") {
        return { choices: choicesFor(query.assignee, match.candidates), text: '"' + query.assignee + '" matches more than one person. Who did you mean?' };
      }
      if (match.status === "unknown") {
        return {
          choices: choicesFor(query.assignee, match.suggestions),
          text: 'I could not find a team member called "' + query.assignee + '"' + (match.suggestions.length ? ". Did you mean one of these?" : "."),
        };
      }
      report.assignedToId = match.match.id;
      report.assigneeLabel = match.match.id === currentUser.id ? "you" : match.match.name;
    }
  }

  return { report };
};

/** Runs one report against the database and words the answer. */
const runTaskReport = async (currentUser, query, context) => {
  const resolved = resolveReport(query, context, currentUser);
  if (!resolved.report) return { choices: resolved.choices || [], items: [], text: resolved.text };

  const { report } = resolved;
  const scope = taskScopeWhere(currentUser);
  const where = buildTaskReportWhere(report, scope, context.today);
  const restricted = !context.me.can.seeAllTasks;
  if (report.groupBy) return runGroupedReport(report, where, context, restricted);
  const overdueWhere = buildTaskReportWhere({ ...report, overdue: true }, scope, context.today);

  const [groups, overdue] = await Promise.all([
    prisma.task.groupBy({ _count: { _all: true }, by: ["status"], where }),
    report.overdue || report.status === "completed" ? Promise.resolve(0) : prisma.task.count({ where: overdueWhere }),
  ]);

  const counts = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
  const total = groups.reduce((sum, group) => sum + group._count._all, 0);
  const text = formatTaskReport({ counts, overdue, report, restricted, total });

  const shouldList = total > 0 && (report.list || total <= AUTO_LIST_MAX);
  const tasks = shouldList
    ? await prisma.task.findMany({
        orderBy: [{ deadline: { nulls: "last", sort: "asc" } }, { updatedAt: "desc" }],
        select: {
          assignedTo: { select: { fullName: true } },
          deadline: true,
          project: { select: { name: true } },
          status: true,
          title: true,
        },
        take: LIST_LIMIT,
        where,
      })
    : [];

  return {
    choices: [],
    items: tasks.map((task) => formatTaskItem(task, context.today)),
    text: text + (total > tasks.length && tasks.length ? " Showing the first " + tasks.length + "." : ""),
  };
};

/** Runs every query in a plan and merges the answers into one reply. */
const runReports = async (currentUser, queries, context) => {
  const answers = [];
  for (const query of queries) answers.push(await runTaskReport(currentUser, query, context));
  return {
    choices: answers.flatMap((answer) => answer.choices),
    items: answers.flatMap((answer) => answer.items),
    text: answers.map((answer) => answer.text).join("\n"),
  };
};

module.exports = {
  buildTaskReportWhere,
  describeSubject,
  formatGroupedReport,
  formatTaskItem,
  formatTaskReport,
  resolveReport,
  runReports,
};
