const ApiError = require("../utils/apiError");

const requireRoles = (...allowedRoles) => (req, _res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return next(new ApiError(403, "You do not have permission to perform this action."));
  }

  return next();
};

module.exports = {
  requireRoles,
};
