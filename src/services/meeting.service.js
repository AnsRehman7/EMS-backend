const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { hasPermission, PERMISSIONS } = require("../utils/permissions");
const { safelyRecordAudit } = require("./audit.service");
const { createForRecipients, safelyNotify } = require("./notification.service");
const {
  attendanceRules,
  currentDateKey,
  eachDateKey,
  getDateRange,
} = require("./attendanceVerification.service");

const MAX_ATTENDEES = 50;

const canManageAll = (user) => hasPermission(user, PERMISSIONS.MEETINGS_MANAGE);

const serializeAttendee = (attendee) => ({
  department: attendee.user?.department || "",
  id: attendee.userId,
  name: attendee.user?.fullName || "Former team member",
  respondedAt: attendee.respondedAt,
  response: String(attendee.response).toLowerCase(),
});

const serializeMeeting = (meeting, currentUser) => {
  const attendees = (meeting.attendees || []).map(serializeAttendee);
  const isOrganizer = meeting.organizerId === currentUser?.id;

  return {
    agenda: meeting.agenda || "",
    attendees,
    // Editing is limited to the organizer, or someone who administers meetings.
    canManage: isOrganizer || canManageAll(currentUser),
    endsAt: meeting.endsAt,
    id: meeting.id,
    isOrganizer,
    location: meeting.location || "",
    meetingUrl: meeting.meetingUrl || "",
    myResponse: attendees.find((attendee) => attendee.id === currentUser?.id)?.response || "",
    organizer: meeting.organizer
      ? { id: meeting.organizer.id, name: meeting.organizer.fullName }
      : null,
    project: meeting.project ? { id: meeting.project.id, name: meeting.project.name } : null,
    startsAt: meeting.startsAt,
    status: String(meeting.status).toLowerCase(),
    task: meeting.task ? { id: meeting.task.id, title: meeting.task.title } : null,
    title: meeting.title,
  };
};

const meetingInclude = {
  attendees: { include: { user: true }, orderBy: { createdAt: "asc" } },
  organizer: true,
  project: true,
  task: true,
};

const parseInstant = (value, label) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, `${label} must be a valid date and time.`);
  return parsed;
};

/**
 * Meetings a member is entitled to see: their own, plus anything they were invited to.
 * Whoever administers meetings sees the whole workspace calendar.
 */
const visibilityWhere = (currentUser) =>
  canManageAll(currentUser)
    ? { organizationId: currentUser.organizationId }
    : {
        organizationId: currentUser.organizationId,
        OR: [{ organizerId: currentUser.id }, { attendees: { some: { userId: currentUser.id } } }],
      };

const resolveAttendeeIds = async (currentUser, attendeeIds = []) => {
  const unique = [...new Set([...attendeeIds, currentUser.id].filter(Boolean))];
  if (unique.length > MAX_ATTENDEES) {
    throw new ApiError(400, `A meeting can hold at most ${MAX_ATTENDEES} attendees.`);
  }

  const members = await prisma.user.findMany({
    select: { id: true },
    where: { id: { in: unique }, organizationId: currentUser.organizationId, status: "ACTIVE" },
  });

  if (members.length !== unique.length) {
    throw new ApiError(400, "One or more attendees are not active members of this workspace.");
  }

  return unique;
};

/**
 * Reports attendees who already have a scheduled meeting overlapping this slot.
 * Surfaced as a warning rather than a hard block, because double-booking is sometimes
 * deliberate and only the organizer knows.
 */
const findConflicts = async ({ attendeeIds, endsAt, excludeMeetingId, organizationId, startsAt }) => {
  const overlapping = await prisma.meeting.findMany({
    include: { attendees: { include: { user: true } } },
    where: {
      // Two ranges overlap when each starts before the other ends.
      endsAt: { gt: startsAt },
      id: excludeMeetingId ? { not: excludeMeetingId } : undefined,
      organizationId,
      startsAt: { lt: endsAt },
      status: "SCHEDULED",
      attendees: { some: { userId: { in: attendeeIds } } },
    },
  });

  const byUser = new Map();
  overlapping.forEach((meeting) => {
    meeting.attendees
      .filter((attendee) => attendeeIds.includes(attendee.userId))
      .forEach((attendee) => {
        if (byUser.has(attendee.userId)) return;
        byUser.set(attendee.userId, {
          meetingTitle: meeting.title,
          name: attendee.user?.fullName || "Team member",
          startsAt: meeting.startsAt,
          userId: attendee.userId,
        });
      });
  });

  return [...byUser.values()];
};

const notifyAttendees = ({ actor, meeting, message, recipientIds, title, type }) =>
  safelyNotify(() =>
    createForRecipients({
      actor,
      notification: {
        actionUrl: "/calendar",
        entityId: meeting.id,
        entityType: "meeting",
        message,
        title,
        type,
      },
      recipientIds,
    }),
  );

const listMeetings = async (currentUser, { from, projectId, status, to, userId } = {}) => {
  const timeZone = currentUser.organization.timezone;
  const today = currentDateKey(timeZone);
  const fromKey = from || today;
  const toKey = to || fromKey;

  const meetings = await prisma.meeting.findMany({
    include: meetingInclude,
    orderBy: { startsAt: "asc" },
    take: 500,
    where: {
      ...visibilityWhere(currentUser),
      endsAt: { gte: getDateRange(fromKey, timeZone).start },
      startsAt: { lt: getDateRange(toKey, timeZone).end },
      ...(projectId ? { projectId } : {}),
      ...(status && status !== "all" ? { status: String(status).toUpperCase() } : {}),
      ...(userId
        ? { OR: [{ organizerId: userId }, { attendees: { some: { userId } } }] }
        : {}),
    },
  });

  return meetings.map((meeting) => serializeMeeting(meeting, currentUser));
};

/**
 * The calendar: meetings laid over the working calendar and the attendance record, so
 * scheduled time can be read against who was actually in.
 */
const getCalendar = async (currentUser, { from, projectId, to, userId } = {}) => {
  const rules = attendanceRules(currentUser.organization);
  const timeZone = rules.timezone;
  const todayKey = currentDateKey(timeZone);
  const fromKey = from || todayKey;
  const toKey = to || fromKey;
  const dateKeys = eachDateKey(fromKey, toKey);

  const rangeStart = getDateRange(fromKey, timeZone).start;
  const rangeEnd = getDateRange(toKey, timeZone).end;
  const canSeeAttendance = hasPermission(currentUser, PERMISSIONS.ATTENDANCE_VIEW_ALL);

  const [meetings, scans] = await Promise.all([
    listMeetings(currentUser, { from: fromKey, projectId, to: toKey, userId }),
    prisma.attendanceScan.findMany({
      select: { direction: true, scannedAt: true, userId: true },
      where: {
        accepted: true,
        organizationId: currentUser.organizationId,
        scannedAt: { gte: rangeStart, lt: rangeEnd },
        // Members without workspace attendance access only see their own presence.
        ...(canSeeAttendance ? (userId ? { userId } : {}) : { userId: currentUser.id }),
      },
    }),
  ]);

  const meetingsByDay = new Map();
  meetings.forEach((meeting) => {
    const key = currentDateKey(timeZone, new Date(meeting.startsAt));
    if (!meetingsByDay.has(key)) meetingsByDay.set(key, []);
    meetingsByDay.get(key).push(meeting);
  });

  const presentByDay = new Map();
  scans.forEach((scan) => {
    const key = currentDateKey(timeZone, scan.scannedAt);
    if (!presentByDay.has(key)) presentByDay.set(key, new Set());
    presentByDay.get(key).add(scan.userId);
  });

  const days = dateKeys.map((dateKey) => {
    const weekday = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
    const dayMeetings = meetingsByDay.get(dateKey) || [];

    return {
      date: dateKey,
      isHoliday: rules.holidays.includes(dateKey),
      isToday: dateKey === todayKey,
      isWorkingDay: rules.workingDays.includes(weekday),
      meetingCount: dayMeetings.length,
      meetings: dayMeetings,
      presentCount: (presentByDay.get(dateKey) || new Set()).size,
    };
  });

  return {
    days,
    range: { from: fromKey, to: toKey },
    rules: {
      timezone: timeZone,
      workdayEnd: rules.officeEnd,
      workdayStart: rules.officeStart,
    },
    showsAttendance: canSeeAttendance || Boolean(scans.length),
  };
};

const createMeeting = async (currentUser, payload) => {
  const startsAt = parseInstant(payload.startsAt, "Meeting start");
  const endsAt = parseInstant(payload.endsAt, "Meeting end");
  if (endsAt <= startsAt) throw new ApiError(400, "The meeting must end after it starts.");

  const attendeeIds = await resolveAttendeeIds(currentUser, payload.attendeeIds);
  const conflicts = await findConflicts({
    attendeeIds,
    endsAt,
    organizationId: currentUser.organizationId,
    startsAt,
  });

  const meeting = await prisma.meeting.create({
    data: {
      agenda: payload.agenda || null,
      attendees: {
        create: attendeeIds.map((userId) => ({
          // The organizer is attending by definition; everyone else is invited.
          response: userId === currentUser.id ? "ACCEPTED" : "INVITED",
          respondedAt: userId === currentUser.id ? new Date() : null,
          userId,
        })),
      },
      endsAt,
      location: payload.location || null,
      meetingUrl: payload.meetingUrl || null,
      organizationId: currentUser.organizationId,
      organizerId: currentUser.id,
      projectId: payload.projectId || null,
      startsAt,
      taskId: payload.taskId || null,
      title: payload.title,
    },
    include: meetingInclude,
  });

  await safelyRecordAudit({
    action: "CREATED",
    actor: currentUser,
    entityId: meeting.id,
    entityType: "MEETING",
    metadata: { attendees: attendeeIds.length, startsAt },
    summary: `${currentUser.fullName} scheduled "${meeting.title}"`,
  });

  await notifyAttendees({
    actor: currentUser,
    meeting,
    message: `${currentUser.fullName} invited you to "${meeting.title}".`,
    recipientIds: attendeeIds.filter((id) => id !== currentUser.id),
    title: "Meeting invitation",
    type: "MEETING_INVITED",
  });

  return { conflicts, meeting: serializeMeeting(meeting, currentUser) };
};

const getManageableMeeting = async (currentUser, meetingId) => {
  const meeting = await prisma.meeting.findFirst({
    include: meetingInclude,
    where: { id: meetingId, organizationId: currentUser.organizationId },
  });

  if (!meeting) throw new ApiError(404, "Meeting not found.");
  if (meeting.organizerId !== currentUser.id && !canManageAll(currentUser)) {
    throw new ApiError(403, "Only the organizer can change this meeting.");
  }

  return meeting;
};

const updateMeeting = async (currentUser, meetingId, payload) => {
  const existing = await getManageableMeeting(currentUser, meetingId);
  const startsAt = payload.startsAt ? parseInstant(payload.startsAt, "Meeting start") : existing.startsAt;
  const endsAt = payload.endsAt ? parseInstant(payload.endsAt, "Meeting end") : existing.endsAt;
  if (endsAt <= startsAt) throw new ApiError(400, "The meeting must end after it starts.");

  const attendeeIds = payload.attendeeIds
    ? await resolveAttendeeIds(currentUser, payload.attendeeIds)
    : existing.attendees.map((attendee) => attendee.userId);

  const rescheduled =
    startsAt.getTime() !== existing.startsAt.getTime() || endsAt.getTime() !== existing.endsAt.getTime();

  const conflicts = await findConflicts({
    attendeeIds,
    endsAt,
    excludeMeetingId: existing.id,
    organizationId: currentUser.organizationId,
    startsAt,
  });

  const meeting = await prisma.$transaction(async (transaction) => {
    if (payload.attendeeIds) {
      const removed = existing.attendees
        .filter((attendee) => !attendeeIds.includes(attendee.userId))
        .map((attendee) => attendee.userId);
      const added = attendeeIds.filter(
        (userId) => !existing.attendees.some((attendee) => attendee.userId === userId),
      );

      if (removed.length) {
        await transaction.meetingAttendee.deleteMany({
          where: { meetingId: existing.id, userId: { in: removed } },
        });
      }
      if (added.length) {
        await transaction.meetingAttendee.createMany({
          data: added.map((userId) => ({ meetingId: existing.id, userId })),
          skipDuplicates: true,
        });
      }
    }

    // Rescheduling invalidates prior answers, so responses reset to invited.
    if (rescheduled) {
      await transaction.meetingAttendee.updateMany({
        data: { respondedAt: null, response: "INVITED" },
        where: { meetingId: existing.id, userId: { not: currentUser.id } },
      });
    }

    return transaction.meeting.update({
      data: {
        ...(payload.agenda !== undefined ? { agenda: payload.agenda || null } : {}),
        ...(payload.location !== undefined ? { location: payload.location || null } : {}),
        ...(payload.meetingUrl !== undefined ? { meetingUrl: payload.meetingUrl || null } : {}),
        ...(payload.projectId !== undefined ? { projectId: payload.projectId || null } : {}),
        ...(payload.taskId !== undefined ? { taskId: payload.taskId || null } : {}),
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        endsAt,
        startsAt,
      },
      include: meetingInclude,
      where: { id: existing.id },
    });
  });

  await safelyRecordAudit({
    action: "UPDATED",
    actor: currentUser,
    entityId: meeting.id,
    entityType: "MEETING",
    metadata: { rescheduled },
    summary: `${currentUser.fullName} updated "${meeting.title}"`,
  });

  await notifyAttendees({
    actor: currentUser,
    meeting,
    message: rescheduled
      ? `"${meeting.title}" was moved to ${meeting.startsAt.toISOString()}.`
      : `"${meeting.title}" was updated.`,
    recipientIds: attendeeIds.filter((id) => id !== currentUser.id),
    title: rescheduled ? "Meeting rescheduled" : "Meeting updated",
    type: "MEETING_UPDATED",
  });

  return { conflicts, meeting: serializeMeeting(meeting, currentUser) };
};

const cancelMeeting = async (currentUser, meetingId) => {
  const existing = await getManageableMeeting(currentUser, meetingId);
  if (existing.status === "CANCELLED") throw new ApiError(409, "This meeting is already cancelled.");

  const meeting = await prisma.meeting.update({
    data: { status: "CANCELLED" },
    include: meetingInclude,
    where: { id: existing.id },
  });

  await safelyRecordAudit({
    action: "CANCELLED",
    actor: currentUser,
    entityId: meeting.id,
    entityType: "MEETING",
    metadata: { startsAt: meeting.startsAt },
    summary: `${currentUser.fullName} cancelled "${meeting.title}"`,
  });

  await notifyAttendees({
    actor: currentUser,
    meeting,
    message: `"${meeting.title}" was cancelled.`,
    recipientIds: meeting.attendees
      .map((attendee) => attendee.userId)
      .filter((id) => id !== currentUser.id),
    title: "Meeting cancelled",
    type: "MEETING_CANCELLED",
  });

  return serializeMeeting(meeting, currentUser);
};

/** Attendees answer their own invitation; nobody answers on their behalf. */
const respondToMeeting = async (currentUser, meetingId, response) => {
  const attendee = await prisma.meetingAttendee.findFirst({
    where: {
      meeting: { organizationId: currentUser.organizationId },
      meetingId,
      userId: currentUser.id,
    },
  });

  if (!attendee) throw new ApiError(404, "You are not invited to this meeting.");

  await prisma.meetingAttendee.update({
    data: { respondedAt: new Date(), response: String(response).toUpperCase() },
    where: { id: attendee.id },
  });

  const meeting = await prisma.meeting.findUnique({ include: meetingInclude, where: { id: meetingId } });

  await notifyAttendees({
    actor: currentUser,
    meeting,
    message: `${currentUser.fullName} ${String(response).toLowerCase()} "${meeting.title}".`,
    recipientIds: [meeting.organizerId].filter((id) => id !== currentUser.id),
    title: "Meeting response",
    type: "MEETING_RESPONSE",
  });

  return serializeMeeting(meeting, currentUser);
};

module.exports = {
  cancelMeeting,
  createMeeting,
  findConflicts,
  getCalendar,
  listMeetings,
  respondToMeeting,
  updateMeeting,
};
