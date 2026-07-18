const express = require("express");
const authController = require("../controllers/auth.controller");
const { authenticate, authenticateFirebase } = require("../middlewares/auth.middleware");

const router = express.Router();

router.post("/sync", authenticateFirebase, authController.syncProfile);
router.get("/me", authenticate, authController.getMe);
router.patch("/me", authenticate, authController.updateMe);

module.exports = router;
