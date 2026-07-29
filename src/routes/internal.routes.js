const express = require("express");
const { processOutbox } = require("../controllers/internal.controller");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.get("/outbox/process", asyncHandler(processOutbox));
router.post("/outbox/process", asyncHandler(processOutbox));

module.exports = router;
