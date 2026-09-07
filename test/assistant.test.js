const test = require("node:test");
const assert = require("node:assert/strict");

const {
  projectCandidate,
  resolveEntity,
  userCandidate,
} = require("../src/services/assistantResolver.service");
const {
  asIsoDate,
  normalizePlan,
  signPlan,
  verifyPlan,
} = require("../src/services/assistant.service");
const { describeAction } = require("../src/services/assistantRunner.service");

const people = [
  { email: "ahmed.raza@daymark.test", fullName: "Ahmed Raza", id: "u1", role: "EMPLOYEE" },
  { email: "sara.khan@daymark.test", fullName: "Sara Khan", id: "u2", role: "MANAGER" },
  { email: "ahmed.malik@daymark.test", fullName: "Ahmed Malik", id: "u3", role: "EMPLOYEE" },
].map((user) => userCandidate({ email: user.email, id: user.id, name: user.fullName, role: user.role }));

const projects = [
  { code: "ATT", id: "p1", name: "Attendance Revamp", status: "ACTIVE" },
  { code: "WEB", id: "p2", name: "Website Redesign", status: "ACTIVE" },
].map(projectCandidate);

/* -------------------------------------------------------------------------- */
/* Entity resolution                                                           */
/* -------------------------------------------------------------------------- */

test("a full name and an email both resolve to the same person", () => {
  assert.equal(resolveEntity("Sara Khan", people).match.id, "u2");
  assert.equal(resolveEntity("sara.khan@daymark.test", people).match.id, "u2");
  assert.equal(resolveEntity("  SARA KHAN  ", people).match.id, "u2");
});

test("a unique first name resolves, but a shared one asks instead of guessing", () => {
  assert.equal(resolveEntity("Sara", people).match.id, "u2");

  // Two people called Ahmed. Picking one would assign real work to the wrong person.
  const ambiguous = resolveEntity("Ahmed", people);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);

  // The full name still disambiguates them.
  assert.equal(resolveEntity("Ahmed Malik", people).match.id, "u3");
});

test("an unknown name is reported rather than matched to the nearest row", () => {
  assert.equal(resolveEntity("Bilal", people).status, "unknown");
  assert.equal(resolveEntity("", people).status, "unknown");
});

test("projects resolve by full name, prefix, and code", () => {
  assert.equal(resolveEntity("Attendance Revamp", projects).match.id, "p1");
  assert.equal(resolveEntity("attendance", projects).match.id, "p1");
  assert.equal(resolveEntity("ATT", projects).match.id, "p1");
});

test("a small typo still resolves", () => {
  assert.equal(resolveEntity("Websit Redesign", projects).match.id, "p2");
});

/* -------------------------------------------------------------------------- */
/* Untrusted model output                                                      */
/* -------------------------------------------------------------------------- */

test("action types outside the allowlist are discarded", () => {
  const plan = normalizePlan({
    actions: [
      { name: "Real project", type: "create_project" },
      { type: "delete_everything" },
      { sql: "DROP TABLE users", type: "run_sql" },
    ],
    reply: "ok",
  });

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "create_project");
});

test("actions missing the fields that make them actionable are dropped", () => {
  const plan = normalizePlan({
    actions: [
      { description: "no title", type: "create_task" },
      { name: "", type: "create_project" },
      { assignee: "", task: "", type: "assign_task" },
    ],
  });

  assert.equal(plan.actions.length, 0);
});

test("impossible and malformed dates are rejected, not rolled forward", () => {
  assert.equal(asIsoDate("2026-09-30"), "2026-09-30");
  assert.equal(asIsoDate("2026-02-30"), "");
  assert.equal(asIsoDate("next friday"), "");
  assert.equal(asIsoDate("30/09/2026"), "");
  assert.equal(asIsoDate(null), "");
});

test("free text from the model is length-capped and coerced", () => {
  const plan = normalizePlan({
    actions: [
      {
        category: "",
        estimatedHours: 99999,
        priority: "URGENT",
        project: "Attendance Revamp",
        title: "x".repeat(500),
        type: "create_task",
      },
    ],
  });

  const [action] = plan.actions;
  assert.equal(action.title.length, 160);
  assert.equal(action.category, "General", "a missing category falls back rather than failing validation");
  assert.equal(action.priority, "normal", "an unsupported priority falls back to normal");
  assert.equal(action.estimatedHours, null, "an out-of-range estimate is dropped");
});

test("a plan needing more than the action cap is truncated", () => {
  const plan = normalizePlan({
    actions: Array.from({ length: 60 }, (_, index) => ({ name: "P" + index, type: "create_project" })),
  });

  assert.equal(plan.actions.length, 25);
});

/* -------------------------------------------------------------------------- */
/* Plan signing                                                                */
/* -------------------------------------------------------------------------- */

const owner = { id: "u1", organizationId: "org1" };

test("a signed plan round-trips for the user who requested it", () => {
  const token = signPlan({
    actions: [{ name: "Attendance Revamp", type: "create_project" }],
    expiresAt: Date.now() + 60_000,
    organizationId: "org1",
    userId: "u1",
  });

  assert.equal(verifyPlan(token, owner).actions[0].name, "Attendance Revamp");
});

test("a tampered plan is rejected", () => {
  const token = signPlan({
    actions: [{ name: "Small project", type: "create_project" }],
    expiresAt: Date.now() + 60_000,
    organizationId: "org1",
    userId: "u1",
  });

  // Swap the body for a different payload while keeping the original signature.
  const forgedBody = Buffer.from(
    JSON.stringify({
      actions: [{ name: "Injected", type: "create_project" }],
      expiresAt: Date.now() + 60_000,
      organizationId: "org1",
      userId: "u1",
    }),
  ).toString("base64url");

  const forged = forgedBody + "." + token.split(".")[1];

  assert.throws(() => verifyPlan(forged, owner), /no longer valid/);
  assert.throws(() => verifyPlan("garbage", owner), /no longer valid/);
});

test("a plan cannot be executed by another user or another workspace", () => {
  const token = signPlan({
    actions: [{ name: "Attendance Revamp", type: "create_project" }],
    expiresAt: Date.now() + 60_000,
    organizationId: "org1",
    userId: "u1",
  });

  assert.throws(() => verifyPlan(token, { id: "u2", organizationId: "org1" }), /different session/);
  assert.throws(() => verifyPlan(token, { id: "u1", organizationId: "org2" }), /different session/);
});

test("an expired plan is refused", () => {
  const token = signPlan({
    actions: [{ name: "Attendance Revamp", type: "create_project" }],
    expiresAt: Date.now() - 1,
    organizationId: "org1",
    userId: "u1",
  });

  assert.throws(() => verifyPlan(token, owner), /expired/);
});

/* -------------------------------------------------------------------------- */
/* Preview text                                                                */
/* -------------------------------------------------------------------------- */

test("previews describe the change in words, not JSON", () => {
  assert.equal(
    describeAction({ dueDate: "2026-09-30", name: "Attendance Revamp", priority: "high", type: "create_project" }),
    "Create project Attendance Revamp · due 2026-09-30 · high priority",
  );

  assert.equal(
    describeAction({
      assigneeLabel: "Sara Khan",
      deadline: "2026-09-05",
      projectLabel: "Attendance Revamp (new)",
      title: "Build the API",
      type: "create_task",
    }),
    "Create task Build the API · in Attendance Revamp (new) · for Sara Khan · due 2026-09-05",
  );

  assert.equal(
    describeAction({ assigneeLabel: "Ahmed Raza", taskLabel: "Build the API", type: "assign_task" }),
    "Assign Build the API to Ahmed Raza",
  );

  // An unassigned task must say so rather than quietly omitting the assignee.
  assert.match(
    describeAction({ projectLabel: "Website Redesign", title: "Draft copy", type: "create_task" }),
    /unassigned/,
  );
});

/* -------------------------------------------------------------------------- */
/* Editing existing records                                                    */
/* -------------------------------------------------------------------------- */

test("a task update keeps only the fields the user asked to change", () => {
  const plan = normalizePlan({
    actions: [
      {
        deadline: "2026-10-15",
        estimatedHours: null,
        priority: "HIGH",
        status: "In Progress",
        task: "Build the API",
        type: "update_task",
      },
    ],
  });

  const [action] = plan.actions;
  assert.equal(action.deadline, "2026-10-15");
  assert.equal(action.priority, "high", "priority is lower-cased for the service layer");
  assert.equal(action.status, "in_progress", "spoken status wording maps onto the stored value");
  assert.equal(action.estimatedHours, null);
});

test("an unsupported status is dropped rather than passed through", () => {
  const plan = normalizePlan({
    actions: [{ status: "almost done", task: "Build the API", type: "update_task" }],
  });

  // Nothing recognisable was requested, so there is no change worth previewing.
  assert.equal(plan.actions.length, 0);
});

test("an update naming no task, or changing nothing, is discarded", () => {
  const plan = normalizePlan({
    actions: [
      { deadline: "2026-10-15", type: "update_task" },
      { task: "Build the API", type: "update_task" },
      { name: "New name", type: "update_project" },
      { project: "Attendance Revamp", type: "update_project" },
    ],
  });

  assert.equal(plan.actions.length, 0);
});

test("a project update coerces its status and priority", () => {
  const plan = normalizePlan({
    actions: [
      {
        dueDate: "2026-12-31",
        priority: "CRITICAL",
        project: "Attendance Revamp",
        status: "Completed",
        type: "update_project",
      },
    ],
  });

  const [action] = plan.actions;
  assert.equal(action.priority, "critical");
  assert.equal(action.status, "completed");
  assert.equal(action.dueDate, "2026-12-31");
});

test("archiving is not something the assistant can do", () => {
  // Archiving a project hides all of its work, so it stays a deliberate manual action.
  const plan = normalizePlan({
    actions: [{ project: "Attendance Revamp", status: "archived", type: "update_project" }],
  });

  assert.equal(plan.actions.length, 0);
});

test("edit previews name the record and list what changes", () => {
  assert.equal(
    describeAction({
      deadline: "2026-10-15",
      priority: "high",
      taskLabel: "Build the API",
      type: "update_task",
    }),
    "Update Build the API · due 2026-10-15 · high priority",
  );

  assert.equal(
    describeAction({
      name: "Attendance Overhaul",
      projectLabel: "Attendance Revamp",
      type: "update_project",
    }),
    "Update project Attendance Revamp · rename to Attendance Overhaul",
  );
});
