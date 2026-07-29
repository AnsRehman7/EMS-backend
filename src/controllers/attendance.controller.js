const attendanceService = require("../services/attendanceVerification.service");
const asyncHandler = require("../utils/asyncHandler");
const {
  createAttendanceCorrectionSchema,
  createAttendanceScanSchema,
  parseBody,
  reviewAttendanceCorrectionSchema,
} = require("../utils/validators");

const issueChallenge = asyncHandler(async (req, res) => {
  const challenge = await attendanceService.issueChallenge(req.user);
  res.status(201).json({ data: { challenge } });
});

const listScans = asyncHandler(async (req, res) => {
  const scans = await attendanceService.listScans(req.user, { date: req.query.date });
  res.status(200).json({ data: { scans } });
});

const listOffices = asyncHandler(async (req, res) => {
  const offices = await attendanceService.listOffices(req.user);
  res.status(200).json({ data: { offices } });
});

const createScan = asyncHandler(async (req, res) => {
  const payload = parseBody(createAttendanceScanSchema, req.body);
  const scan = await attendanceService.createScan(req.user, payload);

  res.status(201).json({ data: { scan } });
});

const listCorrections = asyncHandler(async (req, res) => {
  const corrections = await attendanceService.listCorrections(req.user);
  res.status(200).json({ data: { corrections } });
});

const createCorrection = asyncHandler(async (req, res) => {
  const payload = parseBody(createAttendanceCorrectionSchema, req.body);
  const correction = await attendanceService.createCorrection(req.user, payload);
  res.status(201).json({ data: { correction } });
});

const reviewCorrection = asyncHandler(async (req, res) => {
  const payload = parseBody(reviewAttendanceCorrectionSchema, req.body);
  const correction = await attendanceService.reviewCorrection(req.user, req.params.correctionId, payload);
  res.status(200).json({ data: { correction } });
});

module.exports = {
  createCorrection,
  createScan,
  issueChallenge,
  listOffices,
  listCorrections,
  listScans,
  reviewCorrection,
};
