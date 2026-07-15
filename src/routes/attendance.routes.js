const express = require("express");
const attendanceController = require("../controllers/attendance.controller");
const { authenticate } = require("../middlewares/auth.middleware");

const router = express.Router();

router.use(authenticate);

router.get("/scans", attendanceController.listScans);
router.post("/scans", attendanceController.createScan);

module.exports = router;
