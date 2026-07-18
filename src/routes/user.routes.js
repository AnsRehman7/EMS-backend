const express = require("express");
const userController = require("../controllers/user.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { USER_ROLES } = require("../utils/roles");

const router = express.Router();

router.use(authenticate);

router.get(
  "/employees",
  requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.MANAGER, USER_ROLES.HR, USER_ROLES.ACCOUNTS),
  userController.listEmployees
);
router.get("/", requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.HR), userController.listUsers);
router.get(
  "/:userId",
  requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.HR),
  userController.getUserById
);
router.post("/", requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.HR), userController.createUser);
router.patch("/:userId", requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.HR), userController.updateUser);
router.patch(
  "/:userId/role",
  requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.HR),
  userController.updateUserRole
);
router.delete("/:userId", requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN), userController.deleteUser);

module.exports = router;
