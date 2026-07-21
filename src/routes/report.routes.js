const express = require("express");
const reportController = require("../controllers/report.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();
router.use(authenticate);
router.get("/overview", requirePermission(PERMISSIONS.REPORTS_VIEW), reportController.getOverview);

module.exports = router;
