const express = require("express");
const moduleController = require("../controllers/module.controller");
const { authenticate } = require("../middlewares/auth.middleware");

const router = express.Router();

router.use(authenticate);

router.get("/", moduleController.listAvailableModules);
router.get("/:moduleKey/records/:recordId", moduleController.getRecord);
router.patch("/:moduleKey/records/:recordId", moduleController.updateRecord);
router.delete("/:moduleKey/records/:recordId", moduleController.deleteRecord);
router.get("/:moduleKey/records", moduleController.listRecords);
router.post("/:moduleKey/records", moduleController.createRecord);
router.get("/:moduleKey", moduleController.getModuleByKey);

module.exports = router;
