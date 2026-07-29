const test = require("node:test");
const assert = require("node:assert/strict");
const { averageMetric, getWorkingDays } = require("../src/services/report.service");

test("research metric averages ignore unavailable observations", () => {
  assert.equal(averageMetric([{ coverage: 80 }, { coverage: null }, { coverage: 100 }], "coverage"), 90);
  assert.equal(averageMetric([{ coverage: null }], "coverage"), null);
});

test("capacity reports follow the workspace calendar and holidays", () => {
  const days = getWorkingDays(
    new Date("2026-08-03T00:00:00.000Z"),
    new Date("2026-08-10T00:00:00.000Z"),
    {
      holidays: ["2026-08-05"],
      timezone: "UTC",
      workingDays: [1, 2, 3, 4, 5, 6],
    },
  );

  assert.equal(days, 5);
});
