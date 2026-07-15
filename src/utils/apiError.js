class ApiError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.details = details;
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

module.exports = ApiError;
