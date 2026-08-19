const meetingService = require("../services/meeting.service");
const asyncHandler = require("../utils/asyncHandler");
const {
  createMeetingSchema,
  parseBody,
  respondToMeetingSchema,
  updateMeetingSchema,
} = require("../utils/validators");

const listMeetings = asyncHandler(async (req, res) => {
  const meetings = await meetingService.listMeetings(req.user, {
    from: req.query.from,
    projectId: req.query.projectId,
    status: req.query.status,
    to: req.query.to,
    userId: req.query.userId,
  });
  res.status(200).json({ data: { meetings } });
});

const getCalendar = asyncHandler(async (req, res) => {
  const calendar = await meetingService.getCalendar(req.user, {
    from: req.query.from,
    projectId: req.query.projectId,
    to: req.query.to,
    userId: req.query.userId,
  });
  res.status(200).json({ data: calendar });
});

const createMeeting = asyncHandler(async (req, res) => {
  const payload = parseBody(createMeetingSchema, req.body);
  const { conflicts, meeting } = await meetingService.createMeeting(req.user, payload);
  res.status(201).json({ data: { conflicts, meeting } });
});

const updateMeeting = asyncHandler(async (req, res) => {
  const payload = parseBody(updateMeetingSchema, req.body);
  const { conflicts, meeting } = await meetingService.updateMeeting(req.user, req.params.meetingId, payload);
  res.status(200).json({ data: { conflicts, meeting } });
});

const cancelMeeting = asyncHandler(async (req, res) => {
  const meeting = await meetingService.cancelMeeting(req.user, req.params.meetingId);
  res.status(200).json({ data: { meeting } });
});

const respondToMeeting = asyncHandler(async (req, res) => {
  const payload = parseBody(respondToMeetingSchema, req.body);
  const meeting = await meetingService.respondToMeeting(req.user, req.params.meetingId, payload.response);
  res.status(200).json({ data: { meeting } });
});

module.exports = {
  cancelMeeting,
  createMeeting,
  getCalendar,
  listMeetings,
  respondToMeeting,
  updateMeeting,
};
