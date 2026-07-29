const planningService = require("../services/planning.service");
const asyncHandler = require("../utils/asyncHandler");
const {
  approveProjectPlanSchema,
  generateProjectPlanSchema,
  parseBody,
  reviewProjectPlanSchema,
} = require("../utils/validators");

const listPlans = asyncHandler(async (req, res) => {
  const plans = await planningService.listPlans(req.user, req.params.projectId);
  res.status(200).json({ data: { plans } });
});

const generatePlan = asyncHandler(async (req, res) => {
  const payload = parseBody(generateProjectPlanSchema, req.body);
  const plan = await planningService.generatePlan(req.user, req.params.projectId, payload);
  res.status(201).json({ data: { plan } });
});

const approvePlan = asyncHandler(async (req, res) => {
  const payload = parseBody(approveProjectPlanSchema, req.body);
  const plan = await planningService.approvePlan(
    req.user,
    req.params.projectId,
    req.params.planId,
    payload,
  );
  res.status(200).json({ data: { plan } });
});

const rejectPlan = asyncHandler(async (req, res) => {
  const payload = parseBody(reviewProjectPlanSchema, req.body);
  const plan = await planningService.rejectPlan(
    req.user,
    req.params.projectId,
    req.params.planId,
    payload.reason,
  );
  res.status(200).json({ data: { plan } });
});

const evaluatePlan = asyncHandler(async (req, res) => {
  const payload = parseBody(reviewProjectPlanSchema, req.body);
  const evaluation = await planningService.evaluatePlan(
    req.user,
    req.params.projectId,
    req.params.planId,
    payload.notes,
  );
  res.status(201).json({ data: { evaluation } });
});

module.exports = { approvePlan, evaluatePlan, generatePlan, listPlans, rejectPlan };
