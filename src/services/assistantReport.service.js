const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { hasPermission, PERMISSIONS } = require("../utils/permissions");
const { getAttendanceSummary, getDateRange } = require("./attendanceVerification.service");
const { projectCandidate, resolveEntity, taskCandidate, userCandidate } = require("./assistantResolver.service");
const { startOfDayUtc, statusLabel, taskScopeWhere } = require("./assistant.service");

/**
 * Read-only answers for the workspace assistant.
 *
 * The model decides WHAT is being asked and emits a data_query naming an entity and some
 * filters; this file decides the answer. It is the read-side counterpart of the action
 * allowlist: the model never writes SQL or a Prisma query. Each entity below compiles a
 * fixed set of filters into a query that is always ANDed with the caller's organization
 * and visibility scope - the same scope the matching page of the app applies - so a
 * question can never reveal a record the person could not already open.
 *
 * Counting is done by the database or by this code, never by the model, because a model
 * reading a list of rows miscounts them often enough to matter. Names are resolved by the
 * same deterministic matcher the actions use.
 */

const LIST_LIMIT = 10;

/** Below this many matches the records are listed even when only a count was asked for. */
const AUTO_LIST_MAX = 5;

const GROUP_LIMIT = 15;

/** Upper bound on rows pulled into memory for grouping; far above any one workspace today. */
const ROW_LIMIT = 2000;

const MAX_ATTENDANCE_DAYS = 31;

const plural = (count, word, many = word + "s") => count + " " + (count === 1 ? word : many);

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const titleCase = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const hours = (value) => Math.round(value * 100) / 100 + "h";

const ME_WORDS = ["i", "me", "mine", "my", "myself"];

/** "Wed 5 Nov, 14:00" in the workspace's own timezone. */
const formatDateTime = (value, timeZone) => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      timeZone,
      weekday: "short",
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString().slice(0, 16).replace("T", " ");
  }
};

const isoDay = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "");

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

/** Turns an unresolved name into choices the person can tap instead of retyping. */
const choicesFor = (typed, candidates) =>
  candidates.slice(0, 4).map((candidate) => ({
    label: candidate.name + (candidate.email ? " · " + candidate.email : ""),
    prompt: 'I meant "' + candidate.name + '" (for "' + typed + '"). Please answer my question again.',
  }));

const NAME_KINDS = {
  organizer: { candidates: (context) => context.users.map(userCandidate), noun: "team member", person: true },
  owner: { candidates: (context) => context.users.map(userCandidate), noun: "team member", person: true },
  assignee: { candidates: (context) => context.users.map(userCandidate), noun: "team member", person: true },
  project: { candidates: (context) => context.projects.map(projectCandidate), noun: "project" },
  task: { candidates: (context) => context.tasks.map(taskCandidate), noun: "task" },
};

/**
 * Resolves every name a query mentions. Returns `{ names }` keyed by field, each with the
 * row id and the label to print, or `{ failure }` explaining which name did not match.
 */
const resolveNames = (query, fields, context, currentUser) => {
  const names = {};
  for (const field of fields) {
    const typed = query[field];
    if (!typed) continue;
    const kind = NAME_KINDS[field];

    if (kind.person && ME_WORDS.includes(typed.trim().toLowerCase())) {
      names[field] = { id: currentUser.id, label: "you" };
      continue;
    }

    const match = resolveEntity(typed, kind.candidates(context));
    if (match.status === "resolved") {
      const isMe = kind.person && match.match.id === currentUser.id;
      names[field] = { id: match.match.id, label: isMe ? "you" : match.match.name };
      continue;
    }
    if (match.status === "ambiguous") {
      return {
        failure: {
          choices: choicesFor(typed, match.candidates),
          text: '"' + typed + '" matches more than one ' + kind.noun + ". Which one did you mean?",
        },
      };
    }
    return {
      failure: {
        choices: choicesFor(typed, match.suggestions),
        text:
          'I could not find a ' + kind.noun + ' called "' + typed + '"' +
          (match.suggestions.length ? ". Did you mean one of these?" : "."),
      },
    };
  }
  return { names };
};

/** Folds rows into [{ label, count }] groups, largest first. */
const countGroups = (rows, labelOf, weightOf = () => 1) => {
  const totals = new Map();
  for (const row of rows) {
    const label = labelOf(row);
    totals.set(label, (totals.get(label) || 0) + weightOf(row));
  }
  return [...totals.entries()]
    .map(([label, count]) => ({ count, label }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

/** "Projects by status: active 4, planned 2." Pure. */
const formatGroups = (heading, groups, formatCount = String) => {
  const shown = groups.slice(0, GROUP_LIMIT).map((group) => group.label + " " + formatCount(group.count));
  const hidden = groups.length - shown.length;
  return heading + ": " + shown.join(", ") + (hidden > 0 ? ", and " + hidden + " more" : "") + ".";
};

/** "5 active, 2 planned" - a breakdown worth adding only when there is more than one kind. */
const breakdown = (groups) => (groups.length > 1 ? groups.map((group) => group.count + " " + group.label).join(", ") + "." : "");

const sentence = (count, noun, qualifiers = []) =>
  count
    ? "There " + (count === 1 ? "is " : "are ") + [plural(count, noun.one, noun.many), ...qualifiers].join(" ") + "."
    : "There are no " + [noun.many, ...qualifiers].join(" ") + ".";

const dueQualifiers = (query, from = "dueFrom", to = "dueTo", verb = "due") => {
  if (query[from] && query[to]) return [verb + " " + query[from] + " to " + query[to]];
  if (query[to]) return [verb + " by " + query[to]];
  if (query[from]) return [verb + " from " + query[from]];
  return [];
};

/** Combines a date filter into a Prisma range, or undefined when there is none. */
const dayRange = (fromKey, toKey, timeZone) => {
  const range = {};
  if (fromKey) range.gte = getDateRange(fromKey, timeZone).start;
  if (toKey) range.lt = getDateRange(toKey, timeZone).end;
  return Object.keys(range).length ? range : undefined;
};

const answer = (text, items = [], choices = []) => ({ choices, items, text });

const shouldList = (query, total) => total > 0 && (query.list || total <= AUTO_LIST_MAX);

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

const STATUS_ADJECTIVES = {
  active: "active",
  blocked: "blocked",
  completed: "completed",
  in_progress: "in-progress",
  new: "not-started",
  open: "open",
};

/**
 * Builds the Prisma filter for a resolved task report. Pure, so the tenancy and visibility
 * guarantees are unit tested: the scope is always ANDed in, never merged, so a filter such
 * as "unassigned" cannot overwrite an employee's own-tasks-only restriction.
 */
const buildTaskReportWhere = (report, scope, today) => {
  const filters = {};

  if (report.projectId) filters.projectId = report.projectId;
  if (report.unassigned) filters.assignedToId = null;
  else if (report.assignedToId) filters.assignedToId = report.assignedToId;

  if (report.status === "open") filters.status = { not: "COMPLETED" };
  else if (report.status) filters.status = report.status.toUpperCase();

  if (report.priority) filters.priority = report.priority.toUpperCase();
  if (report.category) filters.category = { contains: report.category, mode: "insensitive" };
  if (report.search) filters.title = { contains: report.search, mode: "insensitive" };

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
  if (report.category) qualifiers.push("in category " + report.category);
  if (report.projectLabel) qualifiers.push("in " + report.projectLabel);
  if (report.unassigned) qualifiers.push("with no assignee");
  else if (report.assigneeLabel) qualifiers.push("assigned to " + report.assigneeLabel);
  if (report.search) qualifiers.push('matching "' + report.search + '"');
  qualifiers.push(...dueQualifiers(report));

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

const TASK_GROUPS = {
  assignee: { key: "assignedToId", word: "person" },
  category: { key: "category", word: "category" },
  priority: { key: "priority", word: "priority" },
  project: { key: "projectId", word: "project" },
  status: { key: "status", word: "status" },
};

/**
 * Words a grouped task report: "Open tasks by person: Ahmed Raza 5, Sara Khan 3." Pure;
 * `groups` is [{ label, count }] already sorted, largest first.
 */
const formatGroupedReport = ({ groups, report, restricted }) => {
  const subject = describeSubject({ ...report, assigneeLabel: "", projectLabel: "" }, "").trim();
  const scope = [report.projectLabel && "in " + report.projectLabel, report.assigneeLabel && "for " + report.assigneeLabel]
    .filter(Boolean)
    .join(" ");

  if (!groups.length) return "There are no " + subject + (scope ? " " + scope : "") + ".";

  const heading = capitalize(subject) + " by " + TASK_GROUPS[report.groupBy].word + (scope ? " " + scope : "");
  return formatGroups(heading, groups) + (restricted ? " (Counting only tasks assigned to you.)" : "");
};

/** One line per listed task, for the panel to render under the answer. */
const formatTaskItem = (task, today) => {
  const parts = [task.project?.name || "No project", task.assignedTo?.fullName || "Unassigned", statusLabel(task.status)];
  if (task.deadline) {
    const due = isoDay(task.deadline);
    parts.push((task.status !== "COMPLETED" && due < today ? "overdue since " : "due ") + due);
  }
  return { detail: parts.join(" · "), title: task.title };
};

const runTasks = async (currentUser, query, context) => {
  const resolved = resolveNames(query, ["project", "assignee"], context, currentUser);
  if (resolved.failure) return answer(resolved.failure.text, [], resolved.failure.choices);

  const report = {
    ...query,
    assignedToId: resolved.names.assignee?.id,
    assigneeLabel: resolved.names.assignee?.label,
    projectId: resolved.names.project?.id,
    projectLabel: resolved.names.project?.label,
  };
  const scope = taskScopeWhere(currentUser);
  const where = buildTaskReportWhere(report, scope, context.today);
  const restricted = !context.me.can.seeAllTasks;

  if (report.groupBy) {
    const { key } = TASK_GROUPS[report.groupBy];
    const names = new Map([
      ...context.projects.map((project) => [project.id, project.name]),
      ...context.users.map((user) => [user.id, user.name]),
    ]);
    const rows = await prisma.task.groupBy({ _count: { _all: true }, by: [key], where });
    const labelFor = (value) => {
      if (report.groupBy === "status") return statusLabel(value);
      if (report.groupBy === "priority") return String(value).toLowerCase();
      if (value === null) return report.groupBy === "project" ? "No project" : "Unassigned";
      return names.get(value) || String(value);
    };
    const groups = rows
      .map((row) => ({ count: row._count._all, label: labelFor(row[key]) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return answer(formatGroupedReport({ groups, report, restricted }));
  }

  const overdueWhere = buildTaskReportWhere({ ...report, overdue: true }, scope, context.today);
  const [groups, overdue] = await Promise.all([
    prisma.task.groupBy({ _count: { _all: true }, by: ["status"], where }),
    report.overdue || report.status === "completed" ? Promise.resolve(0) : prisma.task.count({ where: overdueWhere }),
  ]);

  const counts = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
  const total = groups.reduce((sum, group) => sum + group._count._all, 0);
  const text = formatTaskReport({ counts, overdue, report, restricted, total });

  const tasks = shouldList(report, total)
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

  return answer(
    text + (total > tasks.length && tasks.length ? " Showing the first " + tasks.length + "." : ""),
    tasks.map((task) => formatTaskItem(task, context.today)),
  );
};

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

const PROJECT_STATUS_ENUM = { active: "ACTIVE", archived: "ARCHIVED", completed: "COMPLETED", planned: "PLANNED" };

/** Same visibility as the project list: everything with view_all, else projects you work on. */
const projectScope = (currentUser) => ({
  deletedAt: null,
  organizationId: currentUser.organizationId,
  ...(hasPermission(currentUser, PERMISSIONS.PROJECTS_VIEW_ALL)
    ? {}
    : { tasks: { some: { assignedToId: currentUser.id, deletedAt: null } } }),
});

/** Pure. Archived projects are left out unless they are what was asked for. */
const buildProjectWhere = (query, names, scope, today) => {
  const filters = {};
  const unfinished = { notIn: ["COMPLETED", "ARCHIVED"] };

  if (query.status === "open") filters.status = unfinished;
  else if (query.status) filters.status = PROJECT_STATUS_ENUM[query.status];
  else filters.status = { not: "ARCHIVED" };

  if (query.priority) filters.priority = query.priority.toUpperCase();
  if (names.owner) filters.ownerId = names.owner.id;
  if (query.search) {
    filters.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { code: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const due = {};
  if (query.overdue) {
    due.lt = startOfDayUtc(today);
    if (!query.status) filters.status = unfinished;
  }
  if (query.dueFrom) due.gte = startOfDayUtc(query.dueFrom);
  if (query.dueTo) due.lte = startOfDayUtc(query.dueTo);
  if (Object.keys(due).length) filters.dueDate = due;

  return { AND: [scope, filters] };
};

const runProjects = async (currentUser, query, context) => {
  const resolved = resolveNames(query, ["owner"], context, currentUser);
  if (resolved.failure) return answer(resolved.failure.text, [], resolved.failure.choices);
  const { names } = resolved;

  const where = buildProjectWhere(query, names, projectScope(currentUser), context.today);
  const rows = await prisma.project.findMany({
    orderBy: [{ dueDate: { nulls: "last", sort: "asc" } }, { name: "asc" }],
    select: {
      dueDate: true,
      id: true,
      name: true,
      owner: { select: { fullName: true } },
      priority: true,
      status: true,
    },
    take: ROW_LIMIT,
    where,
  });

  const adjectives = [
    query.overdue && "overdue",
    query.priority && query.priority + "-priority",
    query.status && query.status,
  ].filter(Boolean);
  const qualifiers = [
    names.owner && "owned by " + names.owner.label,
    query.search && 'matching "' + query.search + '"',
    ...dueQualifiers(query),
  ].filter(Boolean);
  const noun = { many: [...adjectives, "projects"].join(" "), one: [...adjectives, "project"].join(" ") };
  const restricted = hasPermission(currentUser, PERMISSIONS.PROJECTS_VIEW_ALL)
    ? ""
    : " (Counting only projects you have tasks in.)";

  if (query.groupBy) {
    const labelOf = {
      owner: (row) => row.owner?.fullName || "No owner",
      priority: (row) => String(row.priority).toLowerCase(),
      status: (row) => statusLabel(row.status),
    }[query.groupBy];
    if (!rows.length) return answer(sentence(0, noun, qualifiers) + restricted);
    return answer(formatGroups(capitalize(noun.many) + " by " + query.groupBy, countGroups(rows, labelOf)) + restricted);
  }

  let text = sentence(rows.length, noun, qualifiers);
  if (!query.status) text += " " + breakdown(countGroups(rows, (row) => statusLabel(row.status)));
  text = text.trim() + restricted;

  const counts = new Map(context.projects.map((project) => [project.id, project.counts]));
  const items = shouldList(query, rows.length)
    ? rows.slice(0, LIST_LIMIT).map((row) => {
        const taskCounts = counts.get(row.id);
        const parts = [statusLabel(row.status), String(row.priority).toLowerCase() + " priority"];
        if (row.dueDate) parts.push("due " + isoDay(row.dueDate));
        parts.push(row.owner?.fullName ? "owner " + row.owner.fullName : "no owner");
        if (taskCounts) parts.push(taskCounts.completed + "/" + taskCounts.total + " tasks done");
        return { detail: parts.join(" · "), title: row.name };
      })
    : [];

  return answer(text + (rows.length > items.length && items.length ? " Showing the first " + items.length + "." : ""), items);
};

/* -------------------------------------------------------------------------- */
/* Team members                                                                */
/* -------------------------------------------------------------------------- */

/** Mirrors who may open the employee picker in the app. */
const DIRECTORY_PERMISSIONS = [
  PERMISSIONS.ATTENDANCE_VIEW_ALL,
  PERMISSIONS.PROJECTS_CREATE,
  PERMISSIONS.PROJECTS_EDIT,
  PERMISSIONS.TASKS_CREATE,
  PERMISSIONS.USERS_VIEW,
];

/** The legacy role column's values; anything else must never reach the enum filter. */
const LEGACY_ROLES = ["ACCOUNTS", "ADMIN", "EMPLOYEE", "HR", "MANAGER", "SUPER_ADMIN"];

/** Suspended accounts carry a placeholder address that is meaningless to show. */
const RELEASED_EMAIL = /@removed\.invalid$/;

const roleLabel = (member) => member.roleRef?.name || titleCase(member.role);

/**
 * Pure. A role matches either a role record (by key or name, "managers" or "Manager") or,
 * for members created before custom roles, the legacy role column.
 */
const buildMemberWhere = (query, organizationId) => {
  const filters = { organizationId };
  if (query.status) filters.status = query.status.toUpperCase();

  if (query.role) {
    const typed = query.role.trim();
    const variants = [...new Set([typed, typed.replace(/s$/i, "")])];
    const legacy = [...new Set(variants.map((value) => value.toUpperCase().replace(/[\s-]+/g, "_")))].filter((value) =>
      LEGACY_ROLES.includes(value),
    );
    filters.OR = [
      ...variants.flatMap((value) => [
        { roleRef: { name: { equals: value, mode: "insensitive" } } },
        { roleRef: { key: { equals: value.toLowerCase().replace(/[\s-]+/g, "_") } } },
      ]),
      ...(legacy.length ? [{ AND: [{ roleId: null }, { role: { in: legacy } }] }] : []),
    ];
  }
  if (query.department) filters.department = { contains: query.department, mode: "insensitive" };
  if (query.designation) filters.designation = { contains: query.designation, mode: "insensitive" };
  if (query.search) {
    filters.AND = [
      {
        OR: [
          { fullName: { contains: query.search, mode: "insensitive" } },
          { email: { contains: query.search, mode: "insensitive" } },
        ],
      },
    ];
  }
  return filters;
};

const runMembers = async (currentUser, query) => {
  if (!DIRECTORY_PERMISSIONS.some((permission) => hasPermission(currentUser, permission))) {
    return answer("You do not have access to the team directory, so I cannot report on team members.");
  }

  const rows = await prisma.user.findMany({
    orderBy: { fullName: "asc" },
    select: {
      department: true,
      designation: true,
      email: true,
      fullName: true,
      role: true,
      roleRef: { select: { name: true } },
      status: true,
    },
    take: ROW_LIMIT,
    where: buildMemberWhere(query, currentUser.organizationId),
  });

  const adjectives = [query.status].filter(Boolean);
  const qualifiers = [
    query.role && "with the role " + query.role,
    query.department && "in " + query.department,
    query.designation && 'with the designation "' + query.designation + '"',
    query.search && 'matching "' + query.search + '"',
  ].filter(Boolean);
  const noun = { many: [...adjectives, "team members"].join(" "), one: [...adjectives, "team member"].join(" ") };

  if (query.groupBy) {
    const labelOf = {
      department: (row) => row.department || "No department",
      designation: (row) => row.designation || "No designation",
      role: roleLabel,
      status: (row) => String(row.status).toLowerCase(),
    }[query.groupBy];
    if (!rows.length) return answer(sentence(0, noun, qualifiers));
    return answer(formatGroups(capitalize(noun.many) + " by " + query.groupBy, countGroups(rows, labelOf)));
  }

  let text = sentence(rows.length, noun, qualifiers);
  if (!query.status) text += " " + breakdown(countGroups(rows, (row) => String(row.status).toLowerCase()));

  const items = shouldList(query, rows.length)
    ? rows.slice(0, LIST_LIMIT).map((row) => ({
        detail: [roleLabel(row), row.designation || row.department, RELEASED_EMAIL.test(row.email) ? "" : row.email, row.status === "SUSPENDED" ? "suspended" : ""]
          .filter(Boolean)
          .join(" · "),
        title: row.fullName,
      }))
    : [];

  return answer(text.trim() + (rows.length > items.length && items.length ? " Showing the first " + items.length + "." : ""), items);
};

/* -------------------------------------------------------------------------- */
/* Meetings                                                                    */
/* -------------------------------------------------------------------------- */

/** Pure. Same visibility as the meetings page: managers see all, others their own. */
const buildMeetingWhere = (query, names, currentUser, timeZone, now = new Date()) => {
  const scope = {
    organizationId: currentUser.organizationId,
    ...(hasPermission(currentUser, PERMISSIONS.MEETINGS_MANAGE)
      ? {}
      : { OR: [{ organizerId: currentUser.id }, { attendees: { some: { userId: currentUser.id } } }] }),
  };
  const filters = {};
  if (query.status === "upcoming") {
    filters.status = "SCHEDULED";
    filters.startsAt = { gte: now };
  } else if (query.status) {
    filters.status = query.status.toUpperCase();
  }
  if (names.project) filters.projectId = names.project.id;
  if (names.organizer) filters.organizerId = names.organizer.id;
  if (names.assignee) filters.attendees = { some: { userId: names.assignee.id } };

  const range = dayRange(query.from, query.to, timeZone);
  if (range) filters.startsAt = { ...(filters.startsAt || {}), ...range };

  return { AND: [scope, filters] };
};

const runMeetings = async (currentUser, query, context) => {
  const resolved = resolveNames(query, ["project", "organizer", "assignee"], context, currentUser);
  if (resolved.failure) return answer(resolved.failure.text, [], resolved.failure.choices);
  const { names } = resolved;

  const rows = await prisma.meeting.findMany({
    orderBy: { startsAt: "asc" },
    select: {
      organizer: { select: { fullName: true } },
      project: { select: { name: true } },
      startsAt: true,
      status: true,
      title: true,
    },
    take: ROW_LIMIT,
    where: buildMeetingWhere(query, names, currentUser, context.timezone),
  });

  const noun = {
    many: [query.status, "meetings"].filter(Boolean).join(" "),
    one: [query.status, "meeting"].filter(Boolean).join(" "),
  };
  const qualifiers = [
    names.project && "for " + names.project.label,
    names.organizer && "organised by " + names.organizer.label,
    names.assignee && "with " + names.assignee.label,
    ...dueQualifiers(query, "from", "to", "on"),
  ].filter(Boolean);
  const labelOfStatus = (row) => String(row.status).toLowerCase();

  if (query.groupBy) {
    const labelOf = {
      organizer: (row) => row.organizer?.fullName || "Unknown",
      project: (row) => row.project?.name || "No project",
      status: labelOfStatus,
    }[query.groupBy];
    if (!rows.length) return answer(sentence(0, noun, qualifiers));
    return answer(formatGroups(capitalize(noun.many) + " by " + query.groupBy, countGroups(rows, labelOf)));
  }

  let text = sentence(rows.length, noun, qualifiers);
  if (!query.status) text += " " + breakdown(countGroups(rows, labelOfStatus));

  const items = shouldList(query, rows.length)
    ? rows.slice(0, LIST_LIMIT).map((row) => ({
        detail: [formatDateTime(row.startsAt, context.timezone), row.project?.name, labelOfStatus(row)].filter(Boolean).join(" · "),
        title: row.title,
      }))
    : [];

  return answer(text.trim() + (rows.length > items.length && items.length ? " Showing the first " + items.length + "." : ""), items);
};

/* -------------------------------------------------------------------------- */
/* Time logs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pure. Time logs carry no organizationId of their own, so tenancy comes through the
 * task, and every filter on the task is ANDed rather than merged into that scope.
 */
const buildTimeLogWhere = (query, names, currentUser, timeZone) => {
  const conditions = [{ task: { deletedAt: null, organizationId: currentUser.organizationId } }];
  if (!hasPermission(currentUser, PERMISSIONS.TASKS_VIEW_ALL)) conditions.push({ userId: currentUser.id });
  if (names.assignee) conditions.push({ userId: names.assignee.id });
  if (names.project) conditions.push({ task: { projectId: names.project.id } });
  if (names.task) conditions.push({ taskId: names.task.id });
  const range = dayRange(query.from, query.to, timeZone);
  if (range) conditions.push({ loggedAt: range });
  return { AND: conditions };
};

const runTimeLogs = async (currentUser, query, context) => {
  const resolved = resolveNames(query, ["assignee", "project", "task"], context, currentUser);
  if (resolved.failure) return answer(resolved.failure.text, [], resolved.failure.choices);
  const { names } = resolved;

  const rows = await prisma.timeLog.findMany({
    orderBy: { loggedAt: "desc" },
    select: {
      hours: true,
      loggedAt: true,
      task: { select: { project: { select: { name: true } }, title: true } },
      user: { select: { fullName: true } },
    },
    take: ROW_LIMIT,
    where: buildTimeLogWhere(query, names, currentUser, context.timezone),
  });

  const total = rows.reduce((sum, row) => sum + Number(row.hours || 0), 0);
  const qualifiers = [
    names.assignee && "by " + names.assignee.label,
    names.task && "on " + names.task.label,
    names.project && "in " + names.project.label,
    query.from && query.to && "between " + query.from + " and " + query.to,
    query.from && !query.to && "since " + query.from,
    !query.from && query.to && "up to " + query.to,
  ]
    .filter(Boolean)
    .join(" ");
  const restricted = hasPermission(currentUser, PERMISSIONS.TASKS_VIEW_ALL) ? "" : " (Counting only your own time.)";

  if (!rows.length) return answer("No time has been logged" + (qualifiers ? " " + qualifiers : "") + "." + restricted);

  if (query.groupBy) {
    const labelOf = {
      assignee: (row) => row.user?.fullName || "Unknown",
      project: (row) => row.task?.project?.name || "No project",
      task: (row) => row.task?.title || "Unknown task",
    }[query.groupBy];
    const groups = countGroups(rows, labelOf, (row) => Number(row.hours || 0));
    return answer(formatGroups("Hours logged by " + (query.groupBy === "assignee" ? "person" : query.groupBy) + (qualifiers ? " " + qualifiers : ""), groups, hours) + restricted);
  }

  const text = hours(total) + " logged across " + plural(rows.length, "entry", "entries") + (qualifiers ? " " + qualifiers : "") + "." + restricted;
  const items = query.list
    ? rows.slice(0, LIST_LIMIT).map((row) => ({
        detail: [row.user?.fullName, hours(Number(row.hours || 0)), isoDay(row.loggedAt), row.task?.project?.name].filter(Boolean).join(" · "),
        title: row.task?.title || "Task",
      }))
    : [];
  return answer(text, items);
};

/* -------------------------------------------------------------------------- */
/* Attendance                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Attendance is answered from the same summary the attendance register shows, which
 * already applies the business-day rule for overnight shifts, holidays, lateness, and the
 * caller's own-records-only scope. Nothing here groups scans by date itself.
 */
const ATTENDANCE_MATCHERS = {
  absent: (row) => row.status === "absent",
  checked_out: (row) => Boolean(row.checkOutAt),
  in_office: (row) => Boolean(row.checkInAt) && !row.checkOutAt,
  late: (row) => row.lateMinutes > 0,
  present: (row) => Boolean(row.checkInAt),
};

const ATTENDANCE_WORDS = {
  absent: "absent",
  checked_out: "checked out",
  in_office: "still in the office",
  late: "late",
  present: "present",
};

const daysBetween = (fromKey, toKey) =>
  Math.round((new Date(toKey + "T00:00:00Z") - new Date(fromKey + "T00:00:00Z")) / 86_400_000) + 1;

/** Pure. "5 present (2 late), 3 absent, 1 off day." from register rows. */
const summarizeAttendance = (rows) => {
  const present = rows.filter(ATTENDANCE_MATCHERS.present).length;
  const late = rows.filter(ATTENDANCE_MATCHERS.late).length;
  const absent = rows.filter(ATTENDANCE_MATCHERS.absent).length;
  const off = rows.filter((row) => row.status === "off_day" || row.status === "holiday").length;
  const parts = [present + " present" + (late ? " (" + late + " late)" : ""), absent + " absent"];
  if (off) parts.push(plural(off, "on a day off", "on a day off"));
  return parts.join(", ") + ".";
};

const runAttendance = async (currentUser, query, context) => {
  const resolved = resolveNames(query, ["assignee"], context, currentUser);
  if (resolved.failure) return answer(resolved.failure.text, [], resolved.failure.choices);
  const person = resolved.names.assignee;
  const canViewAll = hasPermission(currentUser, PERMISSIONS.ATTENDANCE_VIEW_ALL);

  if (person && person.id !== currentUser.id && !canViewAll) {
    return answer("You can only see your own attendance.");
  }

  const fromKey = query.from || query.to || context.today;
  const toKey = query.to && query.to >= fromKey ? query.to : fromKey;
  if (daysBetween(fromKey, toKey) > MAX_ATTENDANCE_DAYS) {
    return answer("I can report attendance for up to " + MAX_ATTENDANCE_DAYS + " days at a time. Try a shorter range.");
  }

  // The register pages its rows; walk the pages so counts cover everyone in range.
  const rows = [];
  for (let page = 1; page <= 50; page += 1) {
    const summary = await getAttendanceSummary(currentUser, {
      department: query.department || undefined,
      from: fromKey,
      page,
      pageSize: 100,
      to: toKey,
      userId: person?.id,
    });
    rows.push(...summary.rows);
    if (page >= summary.pagination.totalPages) break;
  }

  const when = fromKey === toKey ? "on " + fromKey : "from " + fromKey + " to " + toKey;
  const who = person ? (person.label === "you" ? "You" : person.label) : "";
  const scopeNote = canViewAll ? "" : " (Only your own attendance is visible to you.)";
  const multiDay = fromKey !== toKey;

  if (query.status) {
    const matched = rows.filter(ATTENDANCE_MATCHERS[query.status]);
    const word = ATTENDANCE_WORDS[query.status];
    const was = person?.label === "you" ? " were " : " was ";
    const subject = !person
      ? plural(matched.length, multiDay ? "person-day" : "person", multiDay ? "person-days" : "people") +
        (matched.length === 1 ? " was " : " were ") + word + " " + when
      : multiDay
        ? who + was + word + " on " + plural(matched.length, "day") + " " + when
        : who + (matched.length ? was : was.trimEnd() + " not ") + word + " " + when;
    const items = matched.slice(0, LIST_LIMIT).map((row) => ({
      detail: [
        row.date,
        row.checkInAt ? "in " + formatDateTime(row.checkInAt, context.timezone).split(", ").pop() : "",
        row.checkOutAt ? "out " + formatDateTime(row.checkOutAt, context.timezone).split(", ").pop() : "",
        row.lateMinutes ? row.lateMinutes + " min late" : "",
        row.user.department,
      ]
        .filter(Boolean)
        .join(" · "),
      title: row.user.name,
    }));
    return answer(subject + "." + scopeNote, person && !multiDay ? [] : items);
  }

  if (query.groupBy === "department") {
    const present = rows.filter(ATTENDANCE_MATCHERS.present);
    const groups = countGroups(present, (row) => row.user.department || "No department");
    return answer(
      (groups.length ? formatGroups("Present by department " + when, groups) : "Nobody was present " + when + ".") + scopeNote,
    );
  }

  const heading = "Attendance " + when + (who ? " for " + (who === "You" ? "you" : who) : "") + ": ";
  const items = query.list
    ? rows.slice(0, LIST_LIMIT).map((row) => ({
        detail: [row.date, row.status.replace(/_/g, " "), row.lateMinutes ? row.lateMinutes + " min late" : ""].filter(Boolean).join(" · "),
        title: row.user.name,
      }))
    : [];
  return answer(heading + summarizeAttendance(rows) + (multiDay && !person ? " (Counted per person per day.)" : "") + scopeNote, items);
};

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

const RUNNERS = {
  attendance: runAttendance,
  meetings: runMeetings,
  members: runMembers,
  projects: runProjects,
  tasks: runTasks,
  time_logs: runTimeLogs,
};

/** Runs every query in a plan and merges the answers into one reply. */
const runReports = async (currentUser, queries, context) => {
  const answers = [];
  for (const query of queries) {
    try {
      answers.push(await RUNNERS[query.entity](currentUser, query, context));
    } catch (error) {
      // A refusal from a service (a bad date range, say) is an answer, not an outage.
      if (error instanceof ApiError && error.statusCode < 500) answers.push(answer(error.message));
      else throw error;
    }
  }
  return {
    choices: answers.flatMap((item) => item.choices),
    items: answers.flatMap((item) => item.items),
    text: answers.map((item) => item.text).join("\n"),
  };
};

module.exports = {
  buildMeetingWhere,
  buildMemberWhere,
  buildProjectWhere,
  buildTaskReportWhere,
  buildTimeLogWhere,
  describeSubject,
  formatGroupedReport,
  formatGroups,
  formatTaskItem,
  formatTaskReport,
  runReports,
  summarizeAttendance,
};
