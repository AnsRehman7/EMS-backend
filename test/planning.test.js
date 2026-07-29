const test = require("node:test");
const assert = require("node:assert/strict");
const { fallbackBlueprint, normalizePlanBlueprint } = require("../src/services/projectBlueprint.service");
const { schedulePlan, topologicalTasks } = require("../src/services/planning.service");
const { dependencyGraphHasCycle } = require("../src/services/task.service");

const requirements = [
  {
    acceptanceCriteria: "A manager can sign in and see the workspace.",
    description: "Provide authenticated manager access.",
    key: "REQ-001",
    priority: "MUST",
    title: "Manager authentication",
  },
  {
    acceptanceCriteria: "Attendance is rejected outside the office boundary.",
    description: "Verify attendance against an office geofence.",
    key: "REQ-002",
    priority: "MUST",
    title: "Verified attendance",
  },
];

test("deterministic planner keeps every requirement traceable", () => {
  const plan = fallbackBlueprint(requirements);
  const covered = new Set(plan.tasks.flatMap((task) => task.requirementKeys));

  assert.deepEqual([...covered].sort(), ["REQ-001", "REQ-002"]);
  assert.equal(plan.tasks.reduce((sum, task) => sum + task.projectWeight, 0), 100);
  assert.equal(plan.tasks[1].dependencyKeys[0], plan.tasks[0].key);
});

test("AI plan normalization removes invalid references and normalizes weights", () => {
  const normalized = normalizePlanBlueprint(
    {
      assumptions: [],
      milestones: [{ key: "M-1", outcome: "Release accepted", title: "Release" }],
      missingRequirements: [],
      summary: "Deliver in dependency order.",
      tasks: [
        {
          acceptanceCriteria: "API tests pass.",
          category: "Engineering",
          confidence: 82,
          dependencyKeys: ["UNKNOWN"],
          description: "Build the authenticated API.",
          estimatedHours: 8,
          key: "T-1",
          milestoneKey: "M-1",
          priority: "high",
          projectWeight: 1,
          requirementKeys: ["REQ-001", "UNKNOWN"],
          requiredSkills: ["Node.js", "Node.js"],
          riskLevel: "medium",
          title: "Build API",
        },
      ],
    },
    requirements,
  );

  assert.deepEqual(normalized.tasks[0].dependencyKeys, []);
  assert.deepEqual(normalized.tasks[0].requirementKeys, ["REQ-001"]);
  assert.deepEqual(normalized.tasks[0].requiredSkills, ["Node.js"]);
  assert.equal(normalized.tasks[0].projectWeight, 100);
});

test("weight rounding remains nonnegative and totals exactly 100", () => {
  const tasks = Array.from({ length: 32 }, (_, index) => ({
    acceptanceCriteria: `Task ${index + 1} is accepted.`,
    category: "Engineering",
    confidence: 75,
    dependencyKeys: [],
    description: `Deliver task ${index + 1}.`,
    estimatedHours: 1,
    key: `T-${index + 1}`,
    milestoneKey: "",
    priority: "normal",
    projectWeight: index === 31 ? 0.001 : 1,
    requirementKeys: ["REQ-001"],
    requiredSkills: [],
    riskLevel: "low",
    title: `Task ${index + 1}`,
  }));
  const normalized = normalizePlanBlueprint(
    { assumptions: [], milestones: [], missingRequirements: [], summary: "Plan", tasks },
    requirements,
  );
  const total = normalized.tasks.reduce((sum, task) => sum + task.projectWeight, 0);

  assert.equal(Number(total.toFixed(2)), 100);
  assert.ok(normalized.tasks.every((task) => task.projectWeight >= 0 && task.projectWeight <= 100));
});

test("dependency ordering identifies conflicts without losing tasks", () => {
  const result = topologicalTasks([
    { dependencyKeys: ["T-002"], key: "T-001" },
    { dependencyKeys: ["T-001"], key: "T-002" },
    { dependencyKeys: ["MISSING"], key: "T-003" },
  ]);

  assert.equal(result.ordered.length, 3);
  assert.ok(result.warnings.some((warning) => warning.includes("dependency cycle")));
  assert.ok(result.warnings.some((warning) => warning.includes("unknown")));
});

test("manual task dependency graph rejects direct and transitive cycles", () => {
  assert.equal(
    dependencyGraphHasCycle([
      { dependsOnTaskId: "B", taskId: "A" },
      { dependsOnTaskId: "C", taskId: "B" },
      { dependsOnTaskId: "A", taskId: "C" },
    ]),
    true,
  );
  assert.equal(
    dependencyGraphHasCycle([
      { dependsOnTaskId: "B", taskId: "A" },
      { dependsOnTaskId: "C", taskId: "B" },
    ]),
    false,
  );
});

test("constraint scheduler respects dependencies, part-time capacity, and reports overload", () => {
  const blueprint = {
    assumptions: [],
    milestones: [{ key: "M-1", outcome: "Accepted release", title: "Release" }],
    missingRequirements: ["The supported browser matrix is not specified."],
    summary: "Capacity-aware delivery plan.",
    tasks: [
      {
        acceptanceCriteria: "Login works.",
        category: "Engineering",
        confidence: 55,
        dependencyKeys: [],
        description: "Implement login.",
        estimatedHours: 16,
        key: "T-001",
        milestoneKey: "M-1",
        priority: "HIGH",
        projectWeight: 50,
        requirementKeys: ["REQ-001"],
        requiredSkills: ["React"],
        riskLevel: "HIGH",
        title: "Implement login",
      },
      {
        acceptanceCriteria: "Geofence checks pass.",
        category: "Engineering",
        confidence: 80,
        dependencyKeys: ["T-001"],
        description: "Implement geofence.",
        estimatedHours: 16,
        key: "T-002",
        milestoneKey: "M-1",
        priority: "HIGH",
        projectWeight: 50,
        requirementKeys: ["REQ-002"],
        requiredSkills: ["React Native"],
        riskLevel: "MEDIUM",
        title: "Implement geofence",
      },
    ],
  };
  const plan = schedulePlan({
    blueprint,
    organization: {
      holidays: [],
      workdayEnd: "17:00",
      workdayStart: "09:00",
      workingDays: [1, 2, 3, 4, 5],
    },
    project: { dueDate: new Date("2026-08-14T00:00:00.000Z"), startDate: new Date("2026-08-03T00:00:00.000Z") },
    requirements,
    users: [{ fullName: "Part Time Engineer", id: "user-1", skills: ["React"], weeklyCapacityHours: 8 }],
    workloadHours: new Map(),
  });

  assert.ok(plan.tasks[1].scheduledStart > plan.tasks[0].scheduledEnd);
  assert.equal(plan.metrics.requirementCoverage, 100);
  assert.equal(plan.metrics.teamCapacity[0].plannedHours, 32);
  assert.ok(plan.warnings.some((warning) => warning.includes("overloaded")));
  assert.ok(plan.warnings.some((warning) => warning.includes("low planning confidence")));
  assert.ok(plan.warnings.some((warning) => warning.includes("Missing input")));
});
