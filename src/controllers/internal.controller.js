const { timingSafeEqual } = require("crypto");
const { env } = require("../config/env");
const { processOutboxEvents } = require("../services/notification.service");
const ApiError = require("../utils/apiError");

const secretsMatch = (provided, expected) => {
  const providedBuffer = Buffer.from(provided || "");
  const expectedBuffer = Buffer.from(expected || "");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
};

const processOutbox = async (req, res) => {
  if (!env.cronSecret) throw new ApiError(503, "Outbox processing is not configured.");
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!secretsMatch(token, env.cronSecret)) throw new ApiError(401, "Invalid worker credentials.");

  const result = await processOutboxEvents();
  res.status(200).json({ data: result });
};

module.exports = { processOutbox };
