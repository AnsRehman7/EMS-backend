const express = require("express");
const workspaceController = require("../controllers/workspace.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();
router.use(authenticate);
router.get("/settings", workspaceController.getSettings);
router.patch("/settings", requirePermission(PERMISSIONS.SETTINGS_MANAGE), workspaceController.updateSettings);
router.post("/offices", requirePermission(PERMISSIONS.SETTINGS_MANAGE), workspaceController.createOffice);
router.patch("/offices/:officeId", requirePermission(PERMISSIONS.SETTINGS_MANAGE), workspaceController.updateOffice);
router.delete("/offices/:officeId", requirePermission(PERMISSIONS.SETTINGS_MANAGE), workspaceController.deleteOffice);

module.exports = router;
