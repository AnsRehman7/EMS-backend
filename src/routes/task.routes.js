const express = require("express");
const taskController = require("../controllers/task.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();

router.use(authenticate);

router.get("/", taskController.listTasks);
router.get("/stats", taskController.getTaskStats);
router.get("/:taskId", taskController.getTaskById);
router.post(
  "/",
  requirePermission(PERMISSIONS.TASKS_CREATE),
  taskController.createTask
);
router.post("/:taskId/time-logs", taskController.createTimeLog);
router.patch("/:taskId/status", taskController.updateTaskStatus);
router.patch(
  "/:taskId",
  requirePermission(PERMISSIONS.TASKS_EDIT),
  taskController.updateTask
);
router.delete(
  "/:taskId",
  requirePermission(PERMISSIONS.TASKS_DELETE),
  taskController.deleteTask
);

module.exports = router;
