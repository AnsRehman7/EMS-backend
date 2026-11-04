const { ZodError } = require("zod");
const ApiError = require("../utils/apiError");

const errorCodeForStatus = (statusCode) => ({
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
}[statusCode] || (statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"));

/**
 * Database failures that are not bugs in a request but problems with the environment,
 * worded so the person on the other end knows what is wrong and who can fix it. Each is
 * safe to show: none of them echo a query, a value, or a connection string.
 */
const DATABASE_NOT_READY = {
  apiCode: "DATABASE_NOT_READY",
  message:
    "The database has not been set up yet. An administrator needs to run the database migrations " +
    "(prisma migrate deploy) before anyone can sign in.",
  statusCode: 503,
};

const DATABASE_UNAVAILABLE = {
  apiCode: "DATABASE_UNAVAILABLE",
  message: "The database cannot be reached right now. Please try again in a minute.",
  statusCode: 503,
};

const constraintFields = (error) => {
  const target = error.meta?.target ?? error.meta?.driverAdapterError?.cause?.constraint?.fields;
  return (Array.isArray(target) ? target : [target]).filter(Boolean).map(String);
};

/**
 * Maps a Prisma or driver error onto a known, user-facing failure, or null when the error
 * is not one we recognise and should stay a generic 500. Matches on codes and error names
 * rather than importing Prisma's error classes, so it also catches driver-adapter errors.
 */
const classifyDatabaseError = (error) => {
  if (!error || typeof error !== "object") return null;
  const code = String(error.code || "");
  const text = String(error.message || "");

  // The schema is missing or behind the code: tables or columns that do not exist yet.
  if (
    code === "P2021" ||
    code === "P2022" ||
    /does not exist in the current database|relation "[^"]+" does not exist/i.test(text)
  ) {
    return DATABASE_NOT_READY;
  }

  if (
    ["P1000", "P1001", "P1002", "P1008", "P1017", "P2024"].includes(code) ||
    error.name === "PrismaClientInitializationError" ||
    /can't reach database server|ECONNREFUSED|ETIMEDOUT|connection terminated/i.test(text)
  ) {
    return DATABASE_UNAVAILABLE;
  }

  if (code === "P2002") {
    const fields = constraintFields(error);
    return {
      apiCode: "CONFLICT",
      message: fields.length
        ? "A record with this " + fields.join(" and ") + " already exists."
        : "A record with these details already exists.",
      statusCode: 409,
    };
  }

  if (code === "P2025") {
    return { apiCode: "NOT_FOUND", message: "That record no longer exists. Refresh and try again.", statusCode: 404 };
  }

  if (code === "P2003") {
    return {
      apiCode: "CONFLICT",
      message: "This change refers to a record that does not exist, or one that other data still depends on.",
      statusCode: 409,
    };
  }

  return null;
};

const notFound = (req, _res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

const errorHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        details: error.flatten().fieldErrors,
        message: "Request validation failed.",
        requestId: req.requestId,
      },
    });
  }

  const known = error.statusCode ? null : classifyDatabaseError(error);
  const statusCode = known?.statusCode || error.statusCode || 500;
  const message = known?.message ||
    (statusCode >= 500 && !error.isOperational ? "Internal server error." : error.message);

  // Logged in full either way: the response is deliberately vague, the log must not be.
  if (statusCode >= 500 || known) {
    console.error(`[${req.requestId || "no-request-id"}] ${req.method} ${req.originalUrl}`, error);
  }

  return res.status(statusCode).json({
    error: {
      code: known?.apiCode || error.apiCode || errorCodeForStatus(statusCode),
      details: error.details,
      message,
      requestId: req.requestId,
    },
  });
};

module.exports = {
  classifyDatabaseError,
  errorHandler,
  notFound,
};
