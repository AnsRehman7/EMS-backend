const test = require("node:test");
const assert = require("node:assert/strict");

const ApiError = require("../src/utils/apiError");
const gemini = require("../src/services/gemini.service");
const groq = require("../src/services/groq.service");
const llm = require("../src/services/llm.service");

/** Swaps both providers for stubs, so no request leaves the machine. */
const stubProviders = (t, { geminiReady, geminiResult, groqResult }) => {
  t.mock.method(gemini, "isGeminiConfigured", () => geminiReady);
  t.mock.method(groq, "isGroqConfigured", () => true);
  t.mock.method(gemini, "generateJson", async () => geminiResult());
  t.mock.method(groq, "generateJson", async () => groqResult());
  t.mock.method(console, "warn", () => {});
};

test("Gemini answers first and Groq is never called", async (t) => {
  stubProviders(t, { geminiReady: true, geminiResult: () => ({ ok: "gemini" }), groqResult: () => assert.fail("groq called") });
  assert.deepEqual(await llm.generateJson("prompt"), { ok: "gemini" });
});

test("when Gemini fails, Groq takes over", async (t) => {
  stubProviders(t, {
    geminiReady: true,
    geminiResult: () => {
      throw new ApiError(504, "Gemini took too long to respond.");
    },
    groqResult: () => ({ ok: "groq" }),
  });
  assert.deepEqual(await llm.generateJson("prompt"), { ok: "groq" });
});

test("when both fail, the person sees why Gemini failed, not the fallback's key error", async (t) => {
  stubProviders(t, {
    geminiReady: true,
    geminiResult: () => {
      throw new ApiError(503, "Gemini rate limit reached.");
    },
    groqResult: () => {
      throw new ApiError(503, "Groq authentication failed. Check the GROQ_API_KEY configuration.");
    },
  });
  await assert.rejects(llm.generateJson("prompt"), /Gemini rate limit reached/);
});
