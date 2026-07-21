const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createProjectSchema,
  updateTaskSchema,
  updateWorkspaceSettingsSchema,
} = require("../src/utils/validators");
const { normalizeTaskPlan } = require("../src/services/projectPlanning.service");

test("AI project planning requires useful requirements and a due date", () => {
  const result = createProjectSchema.safeParse({
    description: "Too short",
    generateTasksWithAi: true,
    name: "Portal rebuild",
  });

  assert.equal(result.success, false);
  const fields = result.error.flatten().fieldErrors;
  assert.ok(fields.description?.length);
  assert.ok(fields.dueDate?.length);
});

test("workspace schedule rejects an inverted workday", () => {
  const result = updateWorkspaceSettingsSchema.safeParse({
    workdayEnd: "09:00",
    workdayStart: "18:00",
  });

  assert.equal(result.success, false);
  assert.ok(result.error.flatten().fieldErrors.workdayEnd?.length);
});

test("task updates support intentionally clearing an assignee", () => {
  const result = updateTaskSchema.parse({ assignedToId: null, estimatedHours: "2.5" });
  assert.equal(result.assignedToId, null);
  assert.equal(result.estimatedHours, 2.5);
});

test("AI task plans normalize dates, priorities, and weights", () => {
  const plan = normalizeTaskPlan(
    {
      summary: "Delivery plan",
      tasks: [
        {
          category: "Engineering",
          description: "Build the authenticated project API.",
          dueDate: "2026-08-05",
          estimatedHours: 8,
          priority: "urgent",
          projectWeight: 1,
          successCriteria: "Automated API checks pass.",
          title: "Build API",
        },
        {
          category: "QA",
          description: "Validate the completed project workflow.",
          dueDate: "2026-09-30",
          estimatedHours: 4,
          priority: "high",
          projectWeight: 3,
          successCriteria: "Regression checklist is approved.",
          title: "Verify release",
        },
      ],
    },
    { dueDate: "2026-08-20", startDate: "2026-08-01" },
  );

  assert.equal(plan.tasks[0].priority, "NORMAL");
  assert.equal(plan.tasks[1].deadline, "2026-08-20");
  assert.equal(plan.tasks.reduce((sum, task) => sum + task.projectWeight, 0), 100);
});
