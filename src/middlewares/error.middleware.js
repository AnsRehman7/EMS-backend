const { ZodError } = require("zod");
const ApiError = require("../utils/apiError");

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

  const statusCode = error.statusCode || 500;
  const message = statusCode >= 500 && !error.isOperational ? "Internal server error." : error.message;

  if (statusCode >= 500) {
    console.error(`[${req.requestId || "no-request-id"}]`, error);
  }

  return res.status(statusCode).json({
    error: {
      details: error.details,
      message,
      requestId: req.requestId,
    },
  });
};

module.exports = {
  errorHandler,
  notFound,
};
