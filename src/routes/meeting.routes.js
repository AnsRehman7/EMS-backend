const express = require("express");
const meetingController = require("../controllers/meeting.controller");
const { authenticate } = require("../middlewares/auth.middleware");

const router = express.Router();

router.use(authenticate);

// Any member may organize a meeting and answer their own invitations. Editing
// someone else's is gated inside the service by the meetings.manage permission.
router.get("/", meetingController.listMeetings);
router.get("/calendar", meetingController.getCalendar);
router.post("/", meetingController.createMeeting);
router.patch("/:meetingId", meetingController.updateMeeting);
router.post("/:meetingId/respond", meetingController.respondToMeeting);
router.delete("/:meetingId", meetingController.cancelMeeting);

module.exports = router;
