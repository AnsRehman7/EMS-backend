const auditService = require("../services/audit.service");
const asyncHandler = require("../utils/asyncHandler");

const listAuditLogs = asyncHandler(async (req, res) => {
  const auditLogs = await auditService.listAuditLogs(req.user, req.query);
  res.status(200).json({ data: { auditLogs } });
});

module.exports = { listAuditLogs };
