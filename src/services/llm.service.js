const { env } = require("../config/env");
const groq = require("./groq.service");
const gemini = require("./gemini.service");

/**
 * Provider selection for every JSON-generating AI feature.
 *
 * Callers ask for JSON without caring which vendor answers. Gemini is tried first because
 * it is the configured provider for this deployment; Groq stays wired as a fallback so a
 * failure at one vendor - an expired key, a retired model, a rate limit - degrades to the
 * other instead of taking the feature down.
 *
 * Both providers raise the same ApiError shapes, so callers need no provider-specific
 * handling. Only a 5xx-class failure triggers the fallback: a 422 means the request itself
 * was refused, and retrying it elsewhere would just fail again more slowly.
 */

const providers = () => [
  { impl: gemini, name: "gemini", ready: gemini.isGeminiConfigured() },
  { impl: groq, name: "groq", ready: groq.isGroqConfigured() },
];

const isLlmConfigured = () => providers().some((provider) => provider.ready);

/** Names the provider that will serve the next call, for logging and diagnostics. */
const activeProvider = () => providers().find((provider) => provider.ready)?.name || null;

/** Model id for a provider, so callers can record which one actually answered. */
const modelFor = (name) => (name === "gemini" ? env.geminiModel : env.groqModel);

// Which provider served the most recent successful call. Callers store this against the
// generated plan, so it must reflect what really answered rather than what was configured
// first - the two differ whenever the primary provider failed over.
let lastUsed = null;

const lastUsedModel = () => (lastUsed ? modelFor(lastUsed) : null);

const generateJson = async (prompt, options = {}) => {
  const available = providers().filter((provider) => provider.ready);

  if (!available.length) {
    // Surfaced by callers as "AI is not configured", never as a crash.
    return groq.generateJson(prompt, options);
  }

  let lastError;
  for (const provider of available) {
    try {
      const result = await provider.impl.generateJson(prompt, options);
      lastUsed = provider.name;
      return result;
    } catch (error) {
      lastError = error;
      // A refusal or malformed-response error is not worth retrying elsewhere.
      if (error.statusCode && error.statusCode < 500) throw error;
      console.warn(`[llm] ${provider.name} failed, trying the next provider:`, error.message);
    }
  }

  throw lastError;
};

module.exports = {
  activeProvider,
  generateJson,
  isLlmConfigured,
  lastUsedModel,
  modelFor,
};
