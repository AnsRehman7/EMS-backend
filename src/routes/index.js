const express = require("express");
const attendanceRoutes = require("./attendance.routes");
const authRoutes = require("./auth.routes");
const notificationRoutes = require("./notification.routes");
const projectRoutes = require("./project.routes");
const taskRoutes = require("./task.routes");
const userRoutes = require("./user.routes");

const router = express.Router();

router.use("/attendance", attendanceRoutes);
router.use("/auth", authRoutes);
router.use("/notifications", notificationRoutes);
router.use("/projects", projectRoutes);
router.use("/tasks", taskRoutes);
router.use("/users", userRoutes);

module.exports = router;
