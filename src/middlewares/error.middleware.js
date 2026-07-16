const { ZodError } = require("zod");
const ApiError = require("../utils/apiError");

const notFound = (req, _res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

const errorHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        details: error.flatten().fieldErrors,
        message: "Request validation failed.",
      },
    });
  }

  const statusCode = error.statusCode || 500;
  const message = statusCode >= 500 && !error.isOperational ? "Internal server error." : error.message;

  if (statusCode >= 500) {
    console.error(error);
  }

  return res.status(statusCode).json({
    error: {
      details: error.details,
      message,
    },
  });
};

module.exports = {
  errorHandler,
  notFound,
};
