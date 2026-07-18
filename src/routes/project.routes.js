const express = require("express");
const projectController = require("../controllers/project.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();

router.use(authenticate);

router.get("/", projectController.listProjects);
router.get("/:projectId", projectController.getProjectById);
router.post(
  "/",
  requirePermission(PERMISSIONS.PROJECTS_CREATE),
  projectController.createProject
);
router.patch(
  "/:projectId",
  requirePermission(PERMISSIONS.PROJECTS_EDIT),
  projectController.updateProject
);
router.delete(
  "/:projectId",
  requirePermission(PERMISSIONS.PROJECTS_DELETE),
  projectController.deleteProject
);

module.exports = router;
