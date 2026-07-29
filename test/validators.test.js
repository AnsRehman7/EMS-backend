const test = require("node:test");
const assert = require("node:assert/strict");
const {
  approveProjectPlanSchema,
  createModuleSchema,
  createProjectSchema,
  createTaskAttachmentSchema,
  customFieldInputSchema,
  customRecordSchema,
  generateProjectPlanSchema,
  updateCustomFieldSchema,
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

test("planner research timings accept realistic values and reject invalid samples", () => {
  assert.equal(generateProjectPlanSchema.safeParse({ manualBaselineMinutes: 120 }).success, true);
  assert.equal(generateProjectPlanSchema.safeParse({ manualBaselineMinutes: 0 }).success, false);
  assert.equal(
    approveProjectPlanSchema.safeParse({ reviewDurationSeconds: 240, useRecommendations: false }).success,
    true,
  );
  assert.equal(
    approveProjectPlanSchema.safeParse({ reviewDurationSeconds: 86401, useRecommendations: false }).success,
    false,
  );
});

test("structured requirements can replace a long free-form planning brief", () => {
  const result = createProjectSchema.safeParse({
    dueDate: "2026-08-30",
    generateTasksWithAi: true,
    name: "Verified attendance",
    requirements: [
      {
        description: "Reject attendance scans that fall outside every configured office geofence.",
        key: "REQ-001",
        priority: "must",
        title: "Geofence enforcement",
      },
    ],
  });

  assert.equal(result.success, true);
});

test("workspace schedule rejects an inverted workday", () => {
  const result = updateWorkspaceSettingsSchema.safeParse({
    workdayEnd: "09:00",
    workdayStart: "18:00",
  });

  assert.equal(result.success, false);
  assert.ok(result.error.flatten().fieldErrors.workdayEnd?.length);
});

test("workspace schedule rejects invalid calendars and timezones", () => {
  const result = updateWorkspaceSettingsSchema.safeParse({
    holidays: ["2026-02-30"],
    timezone: "Mars/Olympus_Mons",
    workingDays: [1, 1, 2],
  });

  assert.equal(result.success, false);
  const fields = result.error.flatten().fieldErrors;
  assert.ok(fields.holidays?.length);
  assert.ok(fields.timezone?.length);
  assert.ok(fields.workingDays?.length);
});

test("task updates support intentionally clearing an assignee", () => {
  const result = updateTaskSchema.parse({ assignedToId: null, estimatedHours: "2.5" });
  assert.equal(result.assignedToId, null);
  assert.equal(result.estimatedHours, 2.5);
});

test("stored external links require HTTPS", () => {
  assert.equal(
    createTaskAttachmentSchema.safeParse({ name: "Unsafe link", url: "javascript:alert(1)" }).success,
    false,
  );
  assert.equal(
    createTaskAttachmentSchema.safeParse({ name: "Release notes", url: "https://files.example.com/release.pdf" }).success,
    true,
  );
});

test("custom modules require a stable key and at least one typed field", () => {
  const valid = createModuleSchema.safeParse({
    fields: [{ isRequired: true, key: "asset_name", label: "Asset name", type: "text" }],
    key: "assets",
    pluralName: "Assets",
    singularName: "Asset",
  });
  const invalid = createModuleSchema.safeParse({
    fields: [],
    key: "Invalid key",
    pluralName: "Assets",
    singularName: "Asset",
  });

  assert.equal(valid.success, true);
  assert.equal(invalid.success, false);
});

test("custom field and record schemas retain typed values", () => {
  const field = customFieldInputSchema.parse({
    key: "replacement_cost",
    label: "Replacement cost",
    type: "decimal",
    validation: { min: 0 },
  });
  const record = customRecordSchema.parse({
    values: { active: false, replacement_cost: 1250.5, tags: ["insured"] },
  });

  assert.equal(field.type, "decimal");
  assert.equal(field.validation.min, 0);
  assert.deepEqual(record.values.tags, ["insured"]);
});

test("custom field patches do not reset omitted settings", () => {
  const patch = updateCustomFieldSchema.parse({ archived: false });

  assert.deepEqual(patch, { archived: false });
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
