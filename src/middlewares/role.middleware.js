const ApiError = require("../utils/apiError");
const { hasPermission } = require("../utils/permissions");

const requireRoles = (...allowedRoles) => (req, _res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return next(new ApiError(403, "You do not have permission to perform this action."));
  }

  return next();
};

const requirePermission = (permission) => (req, _res, next) => {
  if (!req.user || !hasPermission(req.user, permission)) {
    return next(new ApiError(403, "You do not have permission to perform this action."));
  }

  return next();
};

const requireAnyPermission = (...permissions) => (req, _res, next) => {
  if (!req.user || !permissions.some((permission) => hasPermission(req.user, permission))) {
    return next(new ApiError(403, "You do not have permission to perform this action."));
  }

  return next();
};

module.exports = {
  requireAnyPermission,
  requirePermission,
  requireRoles,
};
