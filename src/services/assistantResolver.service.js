/**
 * Entity resolution for the workspace assistant.
 *
 * The language model proposes plain names ("assign it to Ahmed"). It must never be
 * trusted to produce a database id: given the chance it invents plausible-looking ones.
 * So the model returns names only, and everything in this file maps those names onto
 * real rows using deterministic matching that the model has no influence over.
 *
 * People type the way they talk: half a name ("attendance"), a misspelt word ("logn
 * page"), words out of order ("page login"). Matching is therefore tiered - exact beats
 * prefix beats whole-word beats fuzzy - and fuzzy matching works word by word, so one
 * typo in a long task title does not sink the whole match.
 *
 * Every function here is pure so the whole matching layer can be unit tested without a
 * database, which is how the rest of this backend's tests are written.
 */

/** Levenshtein distance. Inputs are short labels, so the quadratic cost is irrelevant. */
const editDistance = (left, right) => {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      const substitution = previous[j] + (left[i] === right[j] ? 0 : 1);
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1, substitution);
    }
    previous = current;
  }

  return previous[right.length];
};

const normalize = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/["'`’]/g, "")
    .replace(/[^\p{L}\p{N}@.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Someone typing "ahmed" should match "Ahmed Raza"; "raza" should match him too. */
const nameTokens = (value) => normalize(value).split(" ").filter(Boolean);

/**
 * Filler a person or the model wraps around a name: "the login task", "project Apollo".
 * Dropped only for word-level matching, never for the exact tiers, so a task that is
 * genuinely called "Project setup" still matches itself exactly.
 */
const FILLER_WORDS = new Set(["a", "an", "for", "in", "of", "on", "project", "task", "the", "to"]);

const significantTokens = (value) => {
  const tokens = nameTokens(value);
  const kept = tokens.filter((token) => !FILLER_WORDS.has(token));
  return kept.length ? kept : tokens;
};

/** How many typos a word of this length may carry and still count as the same word. */
const typoAllowance = (length) => (length >= 8 ? 2 : length >= 4 ? 1 : 0);

/**
 * How well one typed word matches the best word of a label, from 0 to 1.
 * Exact 1, prefix ("redes" -> "redesign") 0.9, typo ("logn" -> "login") 0.75 or less.
 */
const tokenSimilarity = (queryToken, labelTokens) => {
  let best = 0;
  for (const candidate of labelTokens) {
    if (candidate === queryToken) return 1;
    if (queryToken.length >= 2 && candidate.startsWith(queryToken)) {
      best = Math.max(best, 0.9);
      continue;
    }
    const allowance = typoAllowance(queryToken.length);
    if (allowance) {
      // Compare against the same-length prefix too, so a misspelt half word still lands.
      const distance = Math.min(
        editDistance(queryToken, candidate),
        editDistance(queryToken, candidate.slice(0, queryToken.length)),
      );
      if (distance <= allowance) best = Math.max(best, 0.75 - 0.1 * (distance - 1));
    }
  }
  return best;
};

/**
 * Scores one candidate against a query. Higher is better; null means no match at all.
 *
 *   100  exact label
 *    90  label starts with the query          "attendance" -> "Attendance Revamp"
 *    85  query is a whole-word run in a label "revamp" -> "Attendance Revamp"
 *    75  query appears inside a label
 *    70  every typed word is a word of the label, any order
 *  < 70  word-by-word fuzzy match, scaled by how many words matched and how well
 *
 * The tiers are ordered so an exact identifier always beats a fuzzy guess.
 */
const scoreCandidate = (query, candidate) => {
  const target = normalize(query);
  if (!target) return null;

  const labels = candidate.labels.map(normalize).filter(Boolean);
  const boost = Number(candidate.boost) || 0;
  const tiered = (score) => score + boost;

  if (labels.includes(target)) return tiered(100);
  if (labels.some((label) => label.startsWith(target))) return tiered(90);
  if (labels.some((label) => (" " + label + " ").includes(" " + target + " "))) return tiered(85);
  if (target.length >= 3 && labels.some((label) => label.includes(target))) return tiered(75);

  const queryTokens = significantTokens(query);
  if (!queryTokens.length) return null;

  let best = null;
  for (const label of labels) {
    const labelTokens = nameTokens(label);
    if (queryTokens.every((token) => labelTokens.includes(token))) {
      best = Math.max(best ?? 0, 70);
      continue;
    }

    const similarities = queryTokens.map((token) => tokenSimilarity(token, labelTokens));
    const matched = similarities.filter((value) => value > 0);
    // A single stray word is noise; most of what was typed has to line up.
    if (!matched.length || matched.length < Math.ceil(queryTokens.length * 0.6)) continue;
    // Matching only on a short word such as "ui" or "qa" is too weak to act on.
    if (!queryTokens.some((token, index) => similarities[index] > 0 && token.length >= 3)) continue;

    const coverage = matched.length / queryTokens.length;
    const quality = matched.reduce((sum, value) => sum + value, 0) / matched.length;
    best = Math.max(best ?? 0, Math.round(30 + 38 * coverage * quality));
  }

  // Whole-label typo, for single-word names typed as one blob ("websiteredesign").
  if (best === null && target.length >= 4) {
    const distance = Math.min(...labels.map((label) => editDistance(target, label)));
    if (distance <= Math.floor(target.length / 4) + 1) best = 40 - distance;
  }

  return best === null ? null : tiered(best);
};

/** Below this, fuzzy candidates are close enough to each other that we must ask. */
const FUZZY_TIER = 70;
const FUZZY_MARGIN = 3;

/**
 * Resolves one free-text name against a candidate list.
 *
 * Returns exactly one of:
 *   { status: "resolved",  match, fuzzy }  - fuzzy is true when it was not an exact or
 *                                            whole-word match, so the preview can say so
 *   { status: "ambiguous", candidates }    - two or more equally good matches
 *   { status: "unknown",   suggestions }   - nothing plausible; near misses, if any
 *
 * Ambiguity is never guessed away. Two people called Ahmed must produce a question back
 * to the user, because silently picking one assigns real work to the wrong person.
 */
const resolveEntity = (query, candidates = []) => {
  if (!normalize(query)) return { status: "unknown", suggestions: [] };

  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(query, candidate) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { status: "unknown", suggestions: suggest(query, candidates) };

  const best = scored[0].score;
  // Strong tiers must tie exactly to be ambiguous; fuzzy guesses that are nearly as good
  // as each other are ambiguous too, because the difference is noise.
  const margin = best < FUZZY_TIER ? FUZZY_MARGIN : 0;
  const winners = scored.filter((entry) => entry.score >= best - margin);

  if (winners.length > 1) {
    return { status: "ambiguous", candidates: winners.map((entry) => entry.candidate) };
  }

  return { fuzzy: best < 85, match: scored[0].candidate, status: "resolved" };
};

/**
 * Near misses for a name that matched nothing, so "No task called X" can offer
 * "did you mean ...". Looser than resolution on purpose: these are only ever shown as
 * choices for the person to pick, never acted on.
 */
const suggest = (query, candidates = [], limit = 3) => {
  const queryTokens = significantTokens(query);
  if (!queryTokens.length) return [];

  return candidates
    .map((candidate) => {
      const labelTokens = candidate.labels.flatMap(nameTokens);
      const total = queryTokens.reduce((sum, token) => {
        let best = tokenSimilarity(token, labelTokens);
        if (!best && token.length >= 3) {
          const distance = Math.min(...labelTokens.map((word) => editDistance(token, word)));
          if (distance <= Math.ceil(token.length / 2)) best = 0.3;
        }
        return sum + best;
      }, 0);
      return { candidate, score: total / queryTokens.length };
    })
    .filter((entry) => entry.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate);
};

/** Shapes a user row into a resolver candidate. */
const userCandidate = (user) => ({
  email: user.email,
  id: user.id,
  labels: [user.name, user.email, String(user.email || "").split("@")[0]].filter(Boolean),
  name: user.name,
  role: user.role,
});

/** Shapes a project row into a resolver candidate. */
const projectCandidate = (project) => ({
  id: project.id,
  labels: [project.name, project.code].filter(Boolean),
  name: project.name,
  status: project.status,
});

/**
 * Shapes a task row into a resolver candidate. Open work gets a one-point edge so that
 * when an old completed task shares a title with a live one, the live one is meant.
 */
const taskCandidate = (task) => ({
  boost: task.status === "COMPLETED" ? 0 : 1,
  id: task.id,
  labels: [task.title],
  name: task.title,
  projectId: task.projectId,
  status: task.status,
});

module.exports = {
  editDistance,
  normalize,
  projectCandidate,
  resolveEntity,
  scoreCandidate,
  suggest,
  taskCandidate,
  userCandidate,
};
