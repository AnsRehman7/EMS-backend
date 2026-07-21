const express = require("express");
const attendanceRoutes = require("./attendance.routes");
const auditRoutes = require("./audit.routes");
const authRoutes = require("./auth.routes");
const notificationRoutes = require("./notification.routes");
const reportRoutes = require("./report.routes");
const projectRoutes = require("./project.routes");
const taskRoutes = require("./task.routes");
const userRoutes = require("./user.routes");
const workspaceRoutes = require("./workspace.routes");

const router = express.Router();

router.use("/attendance", attendanceRoutes);
router.use("/audit", auditRoutes);
router.use("/auth", authRoutes);
router.use("/notifications", notificationRoutes);
router.use("/projects", projectRoutes);
router.use("/reports", reportRoutes);
router.use("/tasks", taskRoutes);
router.use("/users", userRoutes);
router.use("/workspace", workspaceRoutes);

module.exports = router;
