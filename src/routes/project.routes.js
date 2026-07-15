const express = require("express");
const projectController = require("../controllers/project.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { USER_ROLES } = require("../utils/roles");

const router = express.Router();

router.use(authenticate);

router.get("/", projectController.listProjects);
router.get("/:projectId", projectController.getProjectById);
router.post(
  "/",
  requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.MANAGER, USER_ROLES.HR),
  projectController.createProject
);
router.patch(
  "/:projectId",
  requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.MANAGER, USER_ROLES.HR),
  projectController.updateProject
);
router.delete(
  "/:projectId",
  requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.MANAGER, USER_ROLES.HR),
  projectController.deleteProject
);

module.exports = router;
