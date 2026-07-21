const reportService = require("../services/report.service");
const asyncHandler = require("../utils/asyncHandler");

const getOverview = asyncHandler(async (req, res) => {
  const report = await reportService.getOverviewReport(req.user, req.query.days);
  res.status(200).json({ data: { report } });
});

module.exports = { getOverview };
