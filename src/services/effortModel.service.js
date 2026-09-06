/**
 * The model is pulled in with a literal require rather than read from disk at runtime.
 *
 * Vercel decides what to bundle into the serverless function by statically tracing
 * require and import calls. A runtime fs.readFileSync - or a require with a computed
 * path - is not reliably followed, so the JSON would be absent in production while
 * working perfectly in development, and weight prediction would silently degrade to its
 * fallback. A literal require makes the dependency visible to the bundler.
 */
const loadModelFile = () => require("../ml/effort_model.json");

/**
 * Task effort estimation using a model trained in-house.
 *
 * The model is a TF-IDF + Ridge regression trained on 22,612 real Jira issues drawn from
 * 16 open-source projects, where each issue carries a story point value assigned by the
 * team that actually did the work. Training lives in the accompanying Kaggle notebook;
 * only the fitted parameters are shipped here.
 *
 * Inference is reimplemented in JavaScript rather than served from a Python process. A
 * Ridge prediction over a TF-IDF vector is a dot product, so porting it removes an entire
 * deployment: no model server, no extra host, and it runs inside the existing serverless
 * function with no cold-start penalty beyond loading one JSON file.
 *
 * The arithmetic below mirrors scikit-learn's TfidfVectorizer defaults exactly -
 * lowercase, the \b\w\w+\b token pattern, 1-2 grams, raw term counts, and L2
 * normalisation. Any drift from those defaults silently changes predictions, so the
 * parity test in test/effort-model.test.js pins the expected outputs.
 */

// Story points in the training data run 1..21; predictions are held to the same range.
const MIN_EFFORT = 1;
const MAX_EFFORT = 21;

let cached;

const loadModel = () => {
  if (cached !== undefined) return cached;
  try {
    const model = loadModelFile();
    if (!model?.vocabulary || !Array.isArray(model.idf) || !Array.isArray(model.coef)) {
      throw new Error("model file is missing vocabulary, idf, or coef");
    }
    cached = model;
  } catch (error) {
    // Loading happens lazily and never at import time: a missing or corrupt model must
    // degrade weight prediction, not take down every route in the deployment.
    console.warn("Effort model unavailable:", error.message);
    cached = null;
  }
  return cached;
};

const isEffortModelReady = () => loadModel() !== null;

/** Matches the cleaning applied to the training corpus before vectorising. */
const normalizeText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** scikit-learn's default token pattern keeps tokens of two or more word characters. */
const tokenize = (text) => text.match(/\b\w\w+\b/g) || [];

/** Unigrams plus bigrams, joined by a single space, as ngram_range=(1, 2) produces. */
const buildTerms = (tokens) => {
  const terms = tokens.slice();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    terms.push(tokens[i] + " " + tokens[i + 1]);
  }
  return terms;
};

/**
 * Predicts the effort of one task from its text.
 *
 * Returns null when the model is unavailable or the text carries no known term, so the
 * caller can fall back rather than record a fabricated estimate.
 */
const predictEffort = (text) => {
  const model = loadModel();
  if (!model) return null;

  const terms = buildTerms(tokenize(normalizeText(text)));
  if (!terms.length) return null;

  // Raw term counts, restricted to the fitted vocabulary.
  const counts = new Map();
  for (const term of terms) {
    const index = model.vocabulary[term];
    if (index !== undefined) counts.set(index, (counts.get(index) || 0) + 1);
  }
  if (!counts.size) return null;

  // tf * idf, then L2 normalise the vector, exactly as TfidfVectorizer.transform does.
  let norm = 0;
  const weighted = new Map();
  for (const [index, count] of counts) {
    const value = count * model.idf[index];
    weighted.set(index, value);
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return null;

  let prediction = model.intercept;
  for (const [index, value] of weighted) {
    prediction += (value / norm) * model.coef[index];
  }

  return Math.min(MAX_EFFORT, Math.max(MIN_EFFORT, prediction));
};

/** Combines a task's fields into the single text the model was trained on. */
const taskText = (task) => [task?.title, task?.description].filter(Boolean).join(" ");

/**
 * Turns predicted efforts into project weights summing to exactly 100.
 *
 * Returns null unless every task produced a prediction: a partial result would weight
 * some tasks by learned effort and others by an arbitrary default, which is worse than
 * falling back to a single consistent strategy.
 */
const predictProjectWeights = (tasks = []) => {
  if (!tasks.length || !isEffortModelReady()) return null;

  const efforts = tasks.map((task) => predictEffort(taskText(task)));
  if (efforts.some((effort) => effort === null)) return null;

  const total = efforts.reduce((sum, effort) => sum + effort, 0);
  if (total <= 0) return null;

  const round2 = (value) => Math.round(value * 100) / 100;
  let assigned = 0;

  return tasks.map((task, index) => {
    // The last task absorbs the rounding remainder so the weights total exactly 100.
    const weight =
      index === tasks.length - 1 ? round2(100 - assigned) : round2((efforts[index] / total) * 100);
    assigned = round2(assigned + weight);
    return { effort: round2(efforts[index]), taskId: task.id, weight };
  });
};

const getModelInfo = () => {
  const model = loadModel();
  if (!model) return null;
  return {
    algorithm: "TF-IDF + Ridge regression",
    features: model.meta?.features ?? model.coef.length,
    projects: model.meta?.projects ?? null,
    trainingRows: model.meta?.rows ?? null,
  };
};

module.exports = {
  buildTerms,
  getModelInfo,
  isEffortModelReady,
  normalizeText,
  predictEffort,
  predictProjectWeights,
  taskText,
  tokenize,
};
