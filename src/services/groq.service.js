const Groq = require("groq-sdk");

const { env } = require("../config/env");
const ApiError = require("../utils/apiError");

const isGroqConfigured = () => Boolean(env.groqApiKey);

const parseJsonResponse = (text) => {
  if (!text) {
    throw new ApiError(502, "Groq returned an empty response.");
  }

  const jsonText = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(jsonText);
  } catch {
    const jsonObject = jsonText.match(/\{[\s\S]*\}/)?.[0];

    if (!jsonObject) {
      throw new ApiError(502, "Groq did not return valid JSON.");
    }

    try {
      return JSON.parse(jsonObject);
    } catch {
      throw new ApiError(502, "Groq did not return valid JSON.");
    }
  }
};

const generateJson = async (prompt, { temperature = 0.2 } = {}) => {
  if (!isGroqConfigured()) {
    throw new ApiError(503, "Groq API key is not configured.");
  }

  const groq = new Groq({
    apiKey: env.groqApiKey,
    maxRetries: 2,
    timeout: 20_000,
  });

  try {
    const response = await groq.chat.completions.create({
      model: env.groqModel,
      messages: [
        {
          role: "system",
          content:
            "Return only one valid JSON object. Do not include markdown fences or explanatory text.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature,
    });

    return parseJsonResponse(response.choices?.[0]?.message?.content);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const status = error.status;
    const upstreamMessage =
      error.error?.error?.message || error.error?.message || error.message;

    if (status === 401 || status === 403) {
      console.warn("[groq] Authentication failed:", upstreamMessage);
      throw new ApiError(
        503,
        "Groq authentication failed. Check the GROQ_API_KEY configuration.",
      );
    }

    if ([400, 404, 422].includes(status)) {
      console.warn("[groq] Request rejected:", upstreamMessage);
      throw new ApiError(
        502,
        "Groq rejected the request. Check GROQ_MODEL and try again.",
      );
    }

    if (status === 429) {
      throw new ApiError(
        503,
        "Groq rate limit reached. Please try again shortly.",
      );
    }

    console.warn("[groq] Request failed:", upstreamMessage);
    throw new ApiError(
      502,
      "Groq could not generate a response. Please try again.",
    );
  }
};

module.exports = {
  generateJson,
  isGroqConfigured,
};
