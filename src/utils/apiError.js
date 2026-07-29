class ApiError extends Error {
  constructor(statusCode, message, details = undefined, apiCode = undefined) {
    super(message);
    this.apiCode = apiCode;
    this.details = details;
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

module.exports = ApiError;
