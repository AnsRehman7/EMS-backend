const express = require("express");
const authController = require("../controllers/auth.controller");
const { authenticate, authenticateFirebase } = require("../middlewares/auth.middleware");
const { rateLimit } = require("../middlewares/rateLimit.middleware");

const router = express.Router();

// Public, unauthenticated: this is how a session starts. Throttling that actually
// protects the codes is enforced per email in the OTP service, since the in-process
// limiter below cannot be trusted across serverless instances.
router.post("/otp/request", rateLimit({ keyPrefix: "otp-request", limit: 10, windowMs: 60_000 }), authController.requestSignInCode);
router.post("/otp/verify", rateLimit({ keyPrefix: "otp-verify", limit: 20, windowMs: 60_000 }), authController.verifySignInCode);

router.post("/sync", authenticateFirebase, authController.syncProfile);
router.get("/me", authenticate, authController.getMe);
router.patch("/me", authenticate, authController.updateMe);

module.exports = router;
