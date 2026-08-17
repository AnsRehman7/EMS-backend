const express = require("express");
const roleController = require("../controllers/role.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/role.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const router = express.Router();

router.use(authenticate);

// Listing is needed by the user directory and assignment dropdowns.
router.get("/", requirePermission(PERMISSIONS.USERS_VIEW), roleController.listRoles);
router.post("/", requirePermission(PERMISSIONS.PERMISSIONS_MANAGE), roleController.createRole);
router.patch("/:roleId", requirePermission(PERMISSIONS.PERMISSIONS_MANAGE), roleController.updateRole);
router.delete("/:roleId", requirePermission(PERMISSIONS.PERMISSIONS_MANAGE), roleController.deleteRole);

module.exports = router;
