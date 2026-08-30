const assistantRunner = require("../services/assistantRunner.service");
const asyncHandler = require("../utils/asyncHandler");
const { assistantExecuteSchema, assistantMessageSchema, parseBody } = require("../utils/validators");

const interpretMessage = asyncHandler(async (req, res) => {
  const payload = parseBody(assistantMessageSchema, req.body);
  const result = await assistantRunner.interpret(req.user, payload.message);
  res.status(200).json({ data: result });
});

const executePlan = asyncHandler(async (req, res) => {
  const payload = parseBody(assistantExecuteSchema, req.body);
  const result = await assistantRunner.execute(req.user, payload.planToken);
  res.status(200).json({ data: result });
});

module.exports = {
  executePlan,
  interpretMessage,
};
