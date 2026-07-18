const express = require("express");
const userController = require("../controllers/user.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requireAnyPermission, requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();

router.use(authenticate);

router.get(
  "/employees",
  requireAnyPermission(
    PERMISSIONS.TASKS_CREATE,
    PERMISSIONS.PROJECTS_CREATE,
    PERMISSIONS.PROJECTS_EDIT,
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW_ALL,
  ),
  userController.listEmployees
);
router.get("/permissions/catalog", requirePermission(PERMISSIONS.USERS_VIEW), userController.getPermissionCatalog);
router.get("/", requirePermission(PERMISSIONS.USERS_VIEW), userController.listUsers);
router.get(
  "/:userId",
  requirePermission(PERMISSIONS.USERS_VIEW),
  userController.getUserById
);
router.post("/", requirePermission(PERMISSIONS.USERS_MANAGE), userController.createUser);
router.patch("/:userId", requirePermission(PERMISSIONS.USERS_MANAGE), userController.updateUser);
router.patch(
  "/:userId/role",
  requirePermission(PERMISSIONS.USERS_MANAGE),
  userController.updateUserRole
);
router.patch(
  "/:userId/permissions",
  requirePermission(PERMISSIONS.PERMISSIONS_MANAGE),
  userController.updateUserPermissions,
);
router.delete("/:userId", requirePermission(PERMISSIONS.USERS_MANAGE), userController.deleteUser);

module.exports = router;
