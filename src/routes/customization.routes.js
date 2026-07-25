const express = require("express");
const moduleController = require("../controllers/module.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission, requireRoles } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();

router.use(authenticate);
router.use(requireRoles("SUPER_ADMIN"));
router.use(requirePermission(PERMISSIONS.CUSTOMIZATION_MANAGE));

router.get("/modules", moduleController.listCustomizationModules);
router.post("/modules", moduleController.createModule);
router.patch("/modules/:moduleId", moduleController.updateModule);
router.post("/modules/:moduleId/fields", moduleController.createField);
router.patch("/modules/:moduleId/fields/:fieldId", moduleController.updateField);
router.delete("/modules/:moduleId/fields/:fieldId", moduleController.archiveField);

module.exports = router;
