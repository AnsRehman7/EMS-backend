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

const generateJson = async (prompt, options = {}) => {
  const available = providers().filter((provider) => provider.ready);

  if (!available.length) {
    // Surfaced by callers as "AI is not configured", never as a crash.
    return groq.generateJson(prompt, options);
  }

  let lastError;
  for (const provider of available) {
    try {
      return await provider.impl.generateJson(prompt, options);
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
};
