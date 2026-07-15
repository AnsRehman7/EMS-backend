const attendanceService = require("../services/attendance.service");
const asyncHandler = require("../utils/asyncHandler");
const { createAttendanceScanSchema, parseBody } = require("../utils/validators");

const listScans = asyncHandler(async (req, res) => {
  const scans = await attendanceService.listScans(req.user, { date: req.query.date });
  res.status(200).json({ data: { scans } });
});

const createScan = asyncHandler(async (req, res) => {
  const payload = parseBody(createAttendanceScanSchema, req.body);
  const scan = await attendanceService.createScan(req.user, payload);

  res.status(201).json({ data: { scan } });
});

module.exports = {
  createScan,
  listScans,
};
