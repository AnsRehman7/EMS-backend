const express = require("express");
const attendanceController = require("../controllers/attendance.controller");
const { authenticate } = require("../middlewares/auth.middleware");

const router = express.Router();

router.use(authenticate);

router.post("/challenge", attendanceController.issueChallenge);
router.get("/offices", attendanceController.listOffices);
router.get("/scans", attendanceController.listScans);
router.get("/summary", attendanceController.getSummary);
router.post("/scans", attendanceController.createScan);
router.get("/corrections", attendanceController.listCorrections);
router.post("/corrections", attendanceController.createCorrection);
router.patch("/corrections/:correctionId", attendanceController.reviewCorrection);

module.exports = router;
