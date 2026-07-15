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
  const url = `${GEMINI_ENDPOINT}/${modelPath}:generateContent?key=${env.geminiApiKey}`;
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
      },
      timeout: 20000,
    }
  );

  return parseJsonResponse(extractText(response));
};

module.exports = {
  generateJson,
  isGeminiConfigured,
};
