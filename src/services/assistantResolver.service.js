/**
 * Entity resolution for the workspace assistant.
 *
 * The language model proposes plain names ("assign it to Ahmed"). It must never be
 * trusted to produce a database id: given the chance it invents plausible-looking ones.
 * So the model returns names only, and everything in this file maps those names onto
 * real rows using deterministic matching that the model has no influence over.
 *
 * Every function here is pure so the whole matching layer can be unit tested without a
 * database, which is how the rest of this backend's tests are written.
 */

/** Levenshtein distance, capped for short strings. Used only as a last-resort tie-break. */
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

const normalize = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

/** Someone typing "ahmed" should match "Ahmed Raza"; "raza" should match him too. */
const nameTokens = (value) => normalize(value).split(" ").filter(Boolean);

/**
 * Scores one candidate against a query. Higher is better; null means no match at all.
 * The tiers are deliberately ordered so an exact identifier always beats a fuzzy guess.
 */
const scoreCandidate = (query, candidate) => {
  const target = normalize(query);
  if (!target) return null;

  const labels = candidate.labels.map(normalize).filter(Boolean);
  if (labels.includes(target)) return 100;

  // Prefix match on the whole label: "attendance" matches "Attendance Revamp".
  if (labels.some((label) => label.startsWith(target))) return 80;
  if (labels.some((label) => label.includes(target))) return 70;

  // Token match: any single word of a name, so first or last name alone resolves.
  const queryTokens = nameTokens(query);
  const candidateTokens = labels.flatMap(nameTokens);
  if (queryTokens.length && queryTokens.every((token) => candidateTokens.includes(token))) return 60;
  if (queryTokens.some((token) => candidateTokens.includes(token))) return 50;

  // Typo tolerance, but only for queries long enough that a near-miss is meaningful.
  if (target.length >= 4) {
    const best = Math.min(...labels.map((label) => editDistance(target, label)));
    if (best <= Math.floor(target.length / 4) + 1) return 40 - best;
  }

  return null;
};

/**
 * Resolves one free-text name against a candidate list.
 *
 * Returns exactly one of:
 *   { status: "resolved",  match }
 *   { status: "ambiguous", candidates }  - two or more equally good matches
 *   { status: "unknown" }                - nothing plausible
 *
 * Ambiguity is never guessed away. Two people called Ahmed must produce a question back
 * to the user, because silently picking one assigns real work to the wrong person.
 */
const resolveEntity = (query, candidates = []) => {
  if (!normalize(query)) return { status: "unknown" };

  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(query, candidate) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { status: "unknown" };

  const best = scored[0].score;
  const winners = scored.filter((entry) => entry.score === best);

  if (winners.length > 1) {
    return { status: "ambiguous", candidates: winners.map((entry) => entry.candidate) };
  }

  return { status: "resolved", match: scored[0].candidate };
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

module.exports = {
  editDistance,
  projectCandidate,
  resolveEntity,
  scoreCandidate,
  userCandidate,
};
