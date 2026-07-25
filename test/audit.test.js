const assert = require("node:assert/strict");
const test = require("node:test");
const { buildChangeSet } = require("../src/services/audit.service");

test("audit change sets contain labeled before and after values", () => {
  const changes = buildChangeSet(
    {
      assignedTo: { fullName: "Ayesha Noor" },
      description: "Initial scope",
      estimatedHours: 8,
      status: "ACTIVE",
    },
    {
      assignedTo: { fullName: "Ali Hasan" },
      description: "Revised scope",
      estimatedHours: 8,
      status: "COMPLETED",
    },
    [
      { field: "description", label: "Description" },
      { field: "estimatedHours", label: "Estimated hours" },
      { field: "status", label: "Status" },
      {
        field: "assignedToId",
        label: "Assignee",
        read: (record) => record.assignedTo.fullName,
      },
    ],
  );

  assert.deepEqual(changes, [
    { field: "description", from: "Initial scope", label: "Description", to: "Revised scope" },
    { field: "status", from: "ACTIVE", label: "Status", to: "COMPLETED" },
    { field: "assignedToId", from: "Ayesha Noor", label: "Assignee", to: "Ali Hasan" },
  ]);
});
