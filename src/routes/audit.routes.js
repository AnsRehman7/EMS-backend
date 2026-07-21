const express = require("express");
const auditController = require("../controllers/audit.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();
router.use(authenticate);
router.get("/", requirePermission(PERMISSIONS.AUDIT_VIEW), auditController.listAuditLogs);

module.exports = router;
