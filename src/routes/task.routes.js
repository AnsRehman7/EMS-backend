const express = require("express");
const taskController = require("../controllers/task.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { USER_ROLES } = require("../utils/roles");

const router = express.Router();

router.use(authenticate);

router.get("/", taskController.listTasks);
router.get("/stats", taskController.getTaskStats);
router.post(
  "/",
  requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.MANAGER, USER_ROLES.HR),
  taskController.createTask
);
router.post("/:taskId/time-logs", taskController.createTimeLog);
router.patch("/:taskId/status", taskController.updateTaskStatus);
router.delete(
  "/:taskId",
  requireRoles(USER_ROLES.SUPER_ADMIN, USER_ROLES.ADMIN, USER_ROLES.MANAGER, USER_ROLES.HR),
  taskController.deleteTask
);

module.exports = router;
