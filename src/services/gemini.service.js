const axios = require("axios");
const { env } = require("../config/env");
const ApiError = require("../utils/apiError");

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

const isGeminiConfigured = () => Boolean(env.geminiApiKey);

const extractText = (response) =>
  response?.data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim() || "";

const parseJsonResponse = (text) => {
  if (!text) {
    throw new ApiError(502, "Gemini returned an empty response.");
  }

  const jsonText = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(jsonText);
  } catch (_error) {
    const match = jsonText.match(/\{[\s\S]*\}/);
    if (!match) throw new ApiError(502, "Gemini did not return valid JSON.");
    return JSON.parse(match[0]);
  }
};

const generateJson = async (prompt, { temperature = 0.2 } = {}) => {
  if (!isGeminiConfigured()) {
    throw new ApiError(503, "Gemini API key is not configured.");
  }

  const modelPath = String(env.geminiModel).startsWith("models/") ? env.geminiModel : `models/${env.geminiModel}`;
  const url = `${GEMINI_ENDPOINT}/${modelPath}:generateContent`;

  try {
    const response = await axios.post(
      url,
      {
        contents: [
          {
            parts: [{ text: prompt }],
            role: "user",
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.geminiApiKey,
        },
        timeout: 20000,
      }
    );

    return parseJsonResponse(extractText(response));
  } catch (error) {
    if (error instanceof ApiError) throw error;

    const upstreamMessage = error.response?.data?.error?.message;
    const status = error.response?.status;

    if (status === 401 || status === 403) {
      console.warn("Gemini authentication failed:", upstreamMessage || status);
      throw new ApiError(503, "Gemini authentication failed. Check the GEMINI_API_KEY configuration.");
    }

    if (status === 400) {
      console.warn("Gemini rejected the generation request:", upstreamMessage || status);
      throw new ApiError(502, "Gemini rejected the request. Check GEMINI_MODEL and try again.");
    }

    throw new ApiError(502, upstreamMessage || "Gemini could not generate a response. Please try again.");
  }
};

module.exports = {
  generateJson,
  isGeminiConfigured,
};
