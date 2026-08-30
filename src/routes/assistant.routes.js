const express = require("express");
const assistantController = require("../controllers/assistant.controller");
const { authenticate } = require("../middlewares/auth.middleware");
const { rateLimit } = require("../middlewares/rateLimit.middleware");

const router = express.Router();

router.use(authenticate);

// Each interpret call costs a model request, so the endpoint is throttled separately from
// the rest of the API. No permission gate here on purpose: anyone may talk to the
// assistant, and each proposed action is authorized individually against the caller.
router.post(
  "/interpret",
  rateLimit({ keyPrefix: "assistant", limit: 20, windowMs: 60_000 }),
  assistantController.interpretMessage,
);
router.post("/execute", assistantController.executePlan);

module.exports = router;
