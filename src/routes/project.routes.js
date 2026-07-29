const express = require("express");
const projectController = require("../controllers/project.controller");
const planningController = require("../controllers/planning.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();

router.use(authenticate);

router.get("/", projectController.listProjects);
router.get("/:projectId/plans", planningController.listPlans);
router.post(
  "/:projectId/plans/generate",
  requirePermission(PERMISSIONS.PROJECTS_EDIT),
  planningController.generatePlan,
);
router.post(
  "/:projectId/plans/:planId/approve",
  requirePermission(PERMISSIONS.PROJECTS_EDIT),
  planningController.approvePlan,
);
router.post(
  "/:projectId/plans/:planId/reject",
  requirePermission(PERMISSIONS.PROJECTS_EDIT),
  planningController.rejectPlan,
);
router.post(
  "/:projectId/plans/:planId/evaluate",
  requirePermission(PERMISSIONS.PROJECTS_EDIT),
  planningController.evaluatePlan,
);
router.get("/:projectId/activity", projectController.getProjectActivity);
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
