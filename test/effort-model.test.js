const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTerms,
  getModelInfo,
  isEffortModelReady,
  normalizeText,
  predictEffort,
  predictProjectWeights,
  tokenize,
} = require("../src/services/effortModel.service");

/* -------------------------------------------------------------------------- */
/* Vectoriser parity                                                           */
/* -------------------------------------------------------------------------- */

test("text is cleaned the same way the training corpus was", () => {
  assert.equal(normalizeText("Fix   the API's  bug!!"), "fix the api s bug");
  assert.equal(normalizeText("MESOS-313: Report  executor"), "mesos 313 report executor");
  assert.equal(normalizeText(null), "");
});

test("tokenising keeps only tokens of two or more characters", () => {
  // scikit-learn's default token pattern is \b\w\w+\b, so single characters drop out.
  assert.deepEqual(tokenize("fix the api s bug"), ["fix", "the", "api", "bug"]);
});

test("terms are unigrams plus bigrams, matching ngram_range=(1, 2)", () => {
  assert.deepEqual(buildTerms(["fix", "the", "bug"]), [
    "fix",
    "the",
    "bug",
    "fix the",
    "the bug",
  ]);
});

/* -------------------------------------------------------------------------- */
/* Predictions                                                                 */
/* -------------------------------------------------------------------------- */

test("the trained model file loads and reports how it was built", () => {
  assert.equal(isEffortModelReady(), true);
  const info = getModelInfo();
  assert.equal(info.features, 4000);
  assert.equal(info.projects, 16);
  assert.equal(info.trainingRows, 22612);
});

test("predictions stay inside the story point range seen in training", () => {
  for (const text of ["fix typo", "implement a distributed consensus protocol", "update docs"]) {
    const effort = predictEffort(text);
    assert.ok(effort >= 1 && effort <= 21, `${text} produced ${effort}`);
  }
});

test("a trivial task scores lower effort than a substantial one", () => {
  const trivial = predictEffort("Fix typo in README");
  const substantial = predictEffort(
    "Implement distributed transaction coordinator across all storage nodes with failure recovery",
  );
  assert.ok(substantial > trivial, `expected ${substantial} > ${trivial}`);
});

test("predictions are pinned, so a change to the vectoriser maths is caught", () => {
  // These values were verified against scikit-learn's own output for the same strings.
  // If they drift, the JavaScript port no longer matches the trained model.
  const cases = [
    ["Fix typo in README", 1.0],
    ["Update documentation for the API", 3.1236],
    ["Implement distributed transaction coordinator across all storage nodes with failure recovery", 8.287],
  ];

  for (const [text, expected] of cases) {
    const actual = predictEffort(text);
    assert.ok(
      Math.abs(actual - expected) < 0.001,
      `"${text}" predicted ${actual}, expected ${expected}`,
    );
  }
});

test("text with no recognisable term returns null rather than a fabricated estimate", () => {
  assert.equal(predictEffort(""), null);
  assert.equal(predictEffort("zzzzq xqzzt"), null);
});

/* -------------------------------------------------------------------------- */
/* Project weights                                                             */
/* -------------------------------------------------------------------------- */

const tasks = [
  { description: "Model the tables and relations for attendance", id: "t1", title: "Design database schema" },
  { description: "Small text change", id: "t2", title: "Fix typo in footer" },
  { description: "Implement create read update delete with validation", id: "t3", title: "Build REST API endpoints" },
];

test("weights always total exactly 100", () => {
  const weights = predictProjectWeights(tasks);
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  assert.equal(Math.round(total * 100) / 100, 100);
});

test("a heavier task receives a larger share than a trivial one", () => {
  const byId = new Map(predictProjectWeights(tasks).map((w) => [w.taskId, w.weight]));
  assert.ok(byId.get("t1") > byId.get("t2"), "schema design should outweigh a typo fix");
});

test("an empty project produces no weights", () => {
  assert.equal(predictProjectWeights([]), null);
});

test("weights are withheld unless every task could be scored", () => {
  // One unscorable task would otherwise be weighted by an arbitrary default while the
  // rest used learned effort, mixing two strategies in one project.
  const mixed = [...tasks, { description: "zzzzq", id: "t4", title: "xqzzt" }];
  assert.equal(predictProjectWeights(mixed), null);
});
