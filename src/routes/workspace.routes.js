const express = require("express");
const workspaceController = require("../controllers/workspace.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();
router.use(authenticate);
router.get("/settings", workspaceController.getSettings);
router.patch("/settings", requirePermission(PERMISSIONS.SETTINGS_MANAGE), workspaceController.updateSettings);

module.exports = router;
