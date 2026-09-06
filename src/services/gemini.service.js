const { env } = require("../config/env");
const ApiError = require("../utils/apiError");

/**
 * Google Gemini JSON generation.
 *
 * Deliberately mirrors the shape of groq.service.js - same function name, same options,
 * same ApiError status codes - so the two are interchangeable behind llm.service.js and
 * a provider can be swapped without touching any caller.
 */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 20_000;

const isGeminiConfigured = () => Boolean(env.geminiApiKey);

/** Gemini honours responseMimeType, but a fenced block still shows up occasionally. */
const parseJsonResponse = (text) => {
  if (!text) throw new ApiError(502, "Gemini returned an empty response.");

  const jsonText = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(jsonText);
  } catch {
    const jsonObject = jsonText.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonObject) throw new ApiError(502, "Gemini did not return valid JSON.");
    try {
      return JSON.parse(jsonObject);
    } catch {
      throw new ApiError(502, "Gemini did not return valid JSON.");
    }
  }
};

const generateJson = async (prompt, { temperature = 0.2 } = {}) => {
  if (!isGeminiConfigured()) {
    throw new ApiError(503, "Gemini API key is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(
      `${API_ROOT}/${encodeURIComponent(env.geminiModel)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`,
      {
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }], role: "user" }],
          generationConfig: { responseMimeType: "application/json", temperature },
          systemInstruction: {
            parts: [{ text: "Return only one valid JSON object. No markdown fences, no commentary." }],
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (error.name === "AbortError") {
      throw new ApiError(504, "Gemini took too long to respond. Please try again.");
    }
    throw new ApiError(502, "Gemini could not be reached. Please try again.");
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const upstream = payload?.error?.message || `HTTP ${response.status}`;

    if (response.status === 401 || response.status === 403) {
      console.warn("[gemini] Authentication failed:", upstream);
      throw new ApiError(503, "Gemini authentication failed. Check the GEMINI_API_KEY configuration.");
    }
    if (response.status === 404) {
      // The configured model name was retired or is not available to this key.
      console.warn("[gemini] Model unavailable:", upstream);
      throw new ApiError(502, "Gemini rejected the request. Check GEMINI_MODEL and try again.");
    }
    if (response.status === 429) {
      throw new ApiError(503, "Gemini rate limit reached. Please try again shortly.");
    }

    console.warn("[gemini] Request failed:", upstream);
    throw new ApiError(502, "Gemini could not generate a response. Please try again.");
  }

  const blocked = payload?.promptFeedback?.blockReason;
  if (blocked) {
    throw new ApiError(422, `Gemini declined the request (${blocked}).`);
  }

  return parseJsonResponse(payload?.candidates?.[0]?.content?.parts?.[0]?.text);
};

module.exports = {
  generateJson,
  isGeminiConfigured,
};
