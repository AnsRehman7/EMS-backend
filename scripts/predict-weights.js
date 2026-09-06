#!/usr/bin/env node
/**
 * Demonstrates the trained effort model directly, with no server and no network.
 *
 * Usage:
 *   node scripts/predict-weights.js "Design database schema" "Fix typo in footer"
 *   node scripts/predict-weights.js            (runs a built-in sample project)
 *
 * The point of this script is verifiability: it loads the same model file the API uses
 * and prints the same numbers the UI displays, so the weights shown in DayMark can be
 * reproduced by hand at any time.
 */

const {
  getModelInfo,
  isEffortModelReady,
  predictEffort,
  predictProjectWeights,
} = require("../src/services/effortModel.service");

const SAMPLE = [
  "Design database schema for attendance records",
  "Fix typo in footer",
  "Build REST API endpoints with validation",
  "Write integration tests for the attendance flow",
];

const titles = process.argv.slice(2).length ? process.argv.slice(2) : SAMPLE;

if (!isEffortModelReady()) {
  console.error("The effort model could not be loaded. Check backend/src/ml/effort_model.json");
  process.exit(1);
}

const info = getModelInfo();
console.log("");
console.log("  Model      : " + info.algorithm);
console.log("  Trained on : " + info.trainingRows.toLocaleString() + " Jira issues from " + info.projects + " projects");
console.log("  Features   : " + info.features.toLocaleString() + " TF-IDF terms");
console.log("  Network    : not used — inference is local and deterministic");
console.log("");

const tasks = titles.map((title, index) => ({ id: "t" + (index + 1), title }));
const weights = predictProjectWeights(tasks);

if (!weights) {
  console.log("  No prediction: at least one task had no term the model recognises.");
  for (const task of tasks) {
    console.log("    " + (predictEffort(task.title) === null ? "unknown" : "ok").padEnd(8) + task.title);
  }
  process.exit(0);
}

const width = Math.max(...titles.map((t) => t.length), 20);
console.log("  " + "TASK".padEnd(width) + "   EFFORT    WEIGHT");
console.log("  " + "-".repeat(width + 20));
for (let i = 0; i < weights.length; i += 1) {
  const row = weights[i];
  console.log(
    "  " + titles[i].padEnd(width) +
    "   " + String(row.effort).padStart(6) +
    "   " + (row.weight.toFixed(2) + "%").padStart(8),
  );
}

const total = weights.reduce((sum, row) => sum + row.weight, 0);
console.log("  " + "-".repeat(width + 20));
console.log("  " + "TOTAL".padEnd(width) + "   " + " ".repeat(6) + "   " + (total.toFixed(2) + "%").padStart(8));
console.log("");
