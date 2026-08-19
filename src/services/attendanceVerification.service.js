const { createHash, randomBytes } = require("crypto");
const prisma = require("../db/prisma");
const { env } = require("../config/env");
const ApiError = require("../utils/apiError");
const { createForRecipients, safelyNotify } = require("./notification.service");
const { canManageAttendance, canViewOrganizationAttendance } = require("../utils/roles");
const { PERMISSIONS } = require("../utils/permissions");
const { findUsersWithPermission } = require("./role.service");
const {
  attachSystemCustomData,
  getSystemEntityData,
  saveSystemEntityData,
  validateSystemCustomValues,
  validateSystemFields,
} = require("./module.service");

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const SCAN_COOLDOWN_MS = 30 * 1000;
const CORRECTION_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
const toNumber = (value) => (value === null || value === undefined ? null : Number(value));
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const normalizeDirection = (value) => String(value || "").trim().toUpperCase();
const toRadians = (degrees) => (degrees * Math.PI) / 180;

const timeZoneOffset = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const hour = Number(values.hour) === 24 ? 0 : Number(values.hour);
  return Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    hour,
    Number(values.minute),
    Number(values.second),
  ) - date.getTime();
};

const zonedMidnight = (dateKey, timeZone) => {
  const utcGuess = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(utcGuess.getTime())) throw new ApiError(400, "Date must use YYYY-MM-DD format.");
  let result = new Date(utcGuess.getTime() - timeZoneOffset(utcGuess, timeZone));
  result = new Date(utcGuess.getTime() - timeZoneOffset(result, timeZone));
  return result;
};

const currentDateKey = (timeZone, date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(date);

const getDateRange = (date, timeZone) => {
  const key = date || currentDateKey(timeZone);
  const start = zonedMidnight(key, timeZone);
  const nextKey = new Date(`${key}T00:00:00.000Z`);
  nextKey.setUTCDate(nextKey.getUTCDate() + 1);
  return { end: zonedMidnight(nextKey.toISOString().slice(0, 10), timeZone), start };
};

const distanceMeters = (latitude, longitude, office) => {
  const earthRadiusMeters = 6_371_000;
  const officeLatitude = Number(office.latitude);
  const officeLongitude = Number(office.longitude);
  const deltaLatitude = toRadians(latitude - officeLatitude);
  const deltaLongitude = toRadians(longitude - officeLongitude);
  const startLatitude = toRadians(officeLatitude);
  const endLatitude = toRadians(latitude);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return Math.round(earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
};

const serializeOffice = (office) => ({
  id: office.id || "environment-office",
  name: office.name,
  radiusMeters: office.radiusMeters,
});

const serializeChallengeOffice = (office) => ({
  ...serializeOffice(office),
  latitude: Number(office.latitude),
  longitude: Number(office.longitude),
  maxAccuracyMeters: office.maxAccuracyMeters,
});

const serializeScan = (scan) => ({
  accepted: scan.accepted,
  accuracyMeters: toNumber(scan.accuracyMeters),
  createdAt: scan.createdAt,
  direction: String(scan.direction).toLowerCase(),
  distanceMeters: toNumber(scan.distanceMeters),
  id: scan.id,
  latitude: toNumber(scan.latitude),
  longitude: toNumber(scan.longitude),
  office: scan.office ? serializeOffice(scan.office) : null,
  rejectionReason: scan.rejectionReason || "",
  scannedAt: scan.scannedAt,
  source: scan.source,
  user: scan.user
    ? {
        department: scan.user.department || "",
        designation: scan.user.designation || "",
        email: scan.user.email,
        id: scan.user.id,
        name: scan.user.fullName,
        role: String(scan.user.role).toLowerCase(),
      }
    : null,
  userId: scan.userId,
});

const activeOffices = async (organizationId) => {
  const offices = await prisma.workspaceOffice.findMany({
    where: { isActive: true, organizationId },
  });
  if (offices.length) return offices;
  if (env.officeLatitude === undefined || env.officeLongitude === undefined) return [];
  return [{
    id: null,
    latitude: env.officeLatitude,
    longitude: env.officeLongitude,
    maxAccuracyMeters: 100,
    name: "Primary office",
    radiusMeters: env.officeRadiusMeters,
  }];
};

const issueChallenge = async (currentUser) => {
  const offices = await activeOffices(currentUser.organizationId);
  if (!offices.length) {
    throw new ApiError(503, "No active attendance office is configured for this workspace.");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await prisma.$transaction(async (transaction) => {
    await transaction.attendanceChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - CHALLENGE_TTL_MS) }, userId: currentUser.id },
    });
    await transaction.attendanceChallenge.create({
      data: {
        expiresAt,
        organizationId: currentUser.organizationId,
        tokenHash: hashToken(token),
        userId: currentUser.id,
      },
    });
  });
  return {
    expiresAt,
    offices: offices.map(serializeChallengeOffice),
    serverTime: new Date(),
    token,
  };
};

const listOffices = async (currentUser) => {
  const offices = await activeOffices(currentUser.organizationId);
  return offices.map(serializeChallengeOffice);
};

const MAX_SUMMARY_DAYS = 92;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const zonedFormatters = new Map();

const zonedParts = (date, timeZone) => {
  if (!zonedFormatters.has(timeZone)) {
    zonedFormatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
        minute: "2-digit",
        month: "2-digit",
        timeZone,
        year: "numeric",
      }),
    );
  }
  const parts = Object.fromEntries(
    zonedFormatters.get(timeZone).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute),
  };
};

const minutesFromClock = (value = "00:00") => {
  const [hours, minutes] = String(value).split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
};

const assertDateKey = (value, label) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw new ApiError(400, `${label} must use YYYY-MM-DD format.`);
  }
  return value;
};

const eachDateKey = (fromKey, toKey) => {
  const keys = [];
  const cursor = new Date(`${fromKey}T00:00:00.000Z`);
  const last = new Date(`${toKey}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) {
    throw new ApiError(400, "Attendance date range is invalid.");
  }
  if (cursor > last) throw new ApiError(400, "The start date must be on or before the end date.");
  while (cursor <= last && keys.length <= MAX_SUMMARY_DAYS) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (keys.length > MAX_SUMMARY_DAYS) {
    throw new ApiError(400, `Attendance history is limited to ${MAX_SUMMARY_DAYS} days per view.`);
  }
  return keys;
};

const scanFilterWhere = (currentUser, { date, from, to, userId } = {}) => {
  const timeZone = currentUser.organization.timezone;
  const canViewAll = canViewOrganizationAttendance(currentUser);
  const range = from || to
    ? {
        end: getDateRange(assertDateKey(to || from, "The end date"), timeZone).end,
        start: getDateRange(assertDateKey(from || to, "The start date"), timeZone).start,
      }
    : getDateRange(date, timeZone);

  if (range.start >= range.end) throw new ApiError(400, "The start date must be on or before the end date.");

  return {
    organizationId: currentUser.organizationId,
    scannedAt: { gte: range.start, lt: range.end },
    ...(canViewAll ? (userId ? { userId } : {}) : { userId: currentUser.id }),
  };
};

const listScans = async (currentUser, { date, from, to, userId } = {}) => {
  const scans = await prisma.attendanceScan.findMany({
    include: { office: true, user: true },
    orderBy: { scannedAt: "asc" },
    take: 2000,
    where: scanFilterWhere(currentUser, { date, from, to, userId }),
  });
  return attachSystemCustomData(currentUser, "attendance", scans.map(serializeScan));
};

const attendanceRules = (organization) => ({
  checkInGraceMinutes: organization.checkInGraceMinutes ?? 60,
  checkoutWindowEnd: organization.checkoutWindowEnd || "18:00",
  checkoutWindowStart: organization.checkoutWindowStart || "16:00",
  holidays: organization.holidays || [],
  minimumOfficeMinutes: organization.minimumOfficeMinutes ?? 360,
  officeEnd: organization.workdayEnd || "18:00",
  officeStart: organization.workdayStart || "09:00",
  timezone: organization.timezone,
  workingDays: organization.workingDays?.length ? organization.workingDays : [1, 2, 3, 4, 5],
});

const buildDayRow = (member, dateKey, scans, rules) => {
  const weekday = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  const isHoliday = rules.holidays.includes(dateKey);
  const isWorkingDay = rules.workingDays.includes(weekday);
  const ordered = [...scans].sort((first, second) => new Date(first.scannedAt) - new Date(second.scannedAt));
  const checkIn = ordered[0] || null;
  const checkoutStart = minutesFromClock(rules.checkoutWindowStart);
  const checkoutEnd = minutesFromClock(rules.checkoutWindowEnd);
  const checkoutCandidates = ordered.filter(
    (scan) =>
      String(scan.direction).toUpperCase() === "OUT" &&
      scan.minutes >= checkoutStart &&
      scan.minutes <= checkoutEnd,
  );
  const checkOut = checkoutCandidates[checkoutCandidates.length - 1] || null;

  let netMinutes = 0;
  let openEntry = null;
  ordered.forEach((scan) => {
    const direction = String(scan.direction).toUpperCase();
    if (direction === "IN" && !openEntry) {
      openEntry = scan;
      return;
    }
    if (direction === "OUT" && openEntry) {
      const span = Math.round((new Date(scan.scannedAt) - new Date(openEntry.scannedAt)) / 60_000);
      if (span > 0) netMinutes += span;
      openEntry = null;
    }
  });

  const grossMinutes =
    checkIn && checkOut
      ? Math.max(0, Math.round((new Date(checkOut.scannedAt) - new Date(checkIn.scannedAt)) / 60_000))
      : 0;
  const lateThreshold = minutesFromClock(rules.officeStart) + rules.checkInGraceMinutes;
  const lateMinutes = checkIn ? Math.max(0, checkIn.minutes - lateThreshold) : 0;

  const status = !checkIn
    ? isHoliday
      ? "holiday"
      : isWorkingDay
        ? "absent"
        : "off_day"
    : checkOut
      ? "checked_out"
      : lateMinutes > 0
        ? "late"
        : "in_office";

  return {
    belowMinimumHours: Boolean(checkOut) && netMinutes < rules.minimumOfficeMinutes,
    checkInAt: checkIn?.scannedAt || null,
    checkOutAt: checkOut?.scannedAt || null,
    date: dateKey,
    grossMinutes,
    id: `${member.id}:${dateKey}`,
    isHoliday,
    isWorkingDay,
    lateMinutes,
    netMinutes,
    scanCount: ordered.length,
    status,
    user: {
      department: member.department || "",
      designation: member.designation || "",
      email: member.email,
      id: member.id,
      name: member.fullName,
      role: String(member.role).toLowerCase(),
    },
  };
};

const getAttendanceSummary = async (
  currentUser,
  { department, from, page, pageSize, search, status, to, userId } = {},
) => {
  const rules = attendanceRules(currentUser.organization);
  const canViewAll = canViewOrganizationAttendance(currentUser);
  const today = currentDateKey(rules.timezone);
  const toKey = assertDateKey(to || from || today, "The end date");
  const fromKey = assertDateKey(from || toKey, "The start date");
  const dateKeys = eachDateKey(fromKey, toKey);
  const scopedUserId = canViewAll ? userId || "" : currentUser.id;

  const [members, scans] = await Promise.all([
    prisma.user.findMany({
      orderBy: { fullName: "asc" },
      select: {
        department: true,
        designation: true,
        email: true,
        fullName: true,
        id: true,
        role: true,
      },
      where: {
        organizationId: currentUser.organizationId,
        status: "ACTIVE",
        ...(scopedUserId ? { id: scopedUserId } : {}),
        ...(department ? { department } : {}),
      },
    }),
    prisma.attendanceScan.findMany({
      orderBy: { scannedAt: "asc" },
      select: { accepted: true, direction: true, id: true, scannedAt: true, userId: true },
      where: {
        accepted: true,
        organizationId: currentUser.organizationId,
        scannedAt: {
          gte: getDateRange(fromKey, rules.timezone).start,
          lt: getDateRange(toKey, rules.timezone).end,
        },
        ...(scopedUserId ? { userId: scopedUserId } : {}),
      },
    }),
  ]);

  const query = String(search || "").trim().toLowerCase();
  const visibleMembers = query
    ? members.filter((member) =>
        [member.fullName, member.email, member.department, member.designation]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(query)),
      )
    : members;

  const scansByUserDay = new Map();
  scans.forEach((scan) => {
    const { dateKey, minutes } = zonedParts(scan.scannedAt, rules.timezone);
    const key = `${scan.userId}:${dateKey}`;
    if (!scansByUserDay.has(key)) scansByUserDay.set(key, []);
    scansByUserDay.get(key).push({ ...scan, minutes });
  });

  const rows = [];
  [...dateKeys].reverse().forEach((dateKey) => {
    visibleMembers.forEach((member) => {
      rows.push(buildDayRow(member, dateKey, scansByUserDay.get(`${member.id}:${dateKey}`) || [], rules));
    });
  });

  const filteredRows = status && status !== "all" ? rows.filter((row) => row.status === status) : rows;
  const totals = filteredRows.reduce(
    (accumulator, row) => ({
      absent: accumulator.absent + (row.status === "absent" ? 1 : 0),
      checkedIn: accumulator.checkedIn + (row.checkInAt ? 1 : 0),
      checkedOut: accumulator.checkedOut + (row.checkOutAt ? 1 : 0),
      late: accumulator.late + (row.lateMinutes > 0 ? 1 : 0),
      netMinutes: accumulator.netMinutes + row.netMinutes,
    }),
    { absent: 0, checkedIn: 0, checkedOut: 0, late: 0, netMinutes: 0 },
  );

  const size = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / size));
  const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const offset = (currentPage - 1) * size;

  return {
    pagination: {
      page: currentPage,
      pageSize: size,
      total: filteredRows.length,
      totalPages,
    },
    range: { from: fromKey, to: toKey },
    rows: filteredRows.slice(offset, offset + size),
    rules: {
      checkInGraceMinutes: rules.checkInGraceMinutes,
      checkoutWindowEnd: rules.checkoutWindowEnd,
      checkoutWindowStart: rules.checkoutWindowStart,
      minimumOfficeMinutes: rules.minimumOfficeMinutes,
      officeEnd: rules.officeEnd,
      officeStart: rules.officeStart,
      timezone: rules.timezone,
    },
    totals,
  };
};

const createScan = async (currentUser, payload) => {
  const customFields = await validateSystemCustomValues({
    currentUser,
    systemKey: "attendance",
    values: payload.customFields,
  });

  if (payload.userId && payload.userId !== currentUser.id) {
    throw new ApiError(
      403,
      "Attendance can only be recorded from a verified device. Use an attendance correction to adjust another member's record.",
    );
  }

  const scanUser = currentUser;
  const direction = normalizeDirection(payload.direction);
  const scannedAt = new Date();
  const offices = await activeOffices(currentUser.organizationId);
  let nearestOffice = null;
  let measuredDistance = null;
  let rejectionReason = null;

  if (!payload.challengeToken) throw new ApiError(400, "Start a fresh attendance check before scanning.");
  if (!offices.length) throw new ApiError(503, "No active attendance office is configured for this workspace.");
  if (payload.latitude === undefined || payload.longitude === undefined) {
    throw new ApiError(422, "A precise device location is required for attendance.");
  }

  const measured = offices
    .map((office) => ({ distance: distanceMeters(payload.latitude, payload.longitude, office), office }))
    .sort((first, second) => first.distance - second.distance)[0];
  nearestOffice = measured.office;
  measuredDistance = measured.distance;
  if (payload.accuracyMeters === undefined) {
    rejectionReason = "Location accuracy was not provided by the device.";
  } else if (payload.accuracyMeters > nearestOffice.maxAccuracyMeters) {
    rejectionReason = `Location accuracy must be within ${nearestOffice.maxAccuracyMeters} meters.`;
  } else if (measuredDistance > nearestOffice.radiusMeters) {
    rejectionReason = `Outside ${nearestOffice.name} by ${Math.round(measuredDistance - nearestOffice.radiusMeters)} meters.`;
  }

  await validateSystemFields({
    currentUser,
    systemKey: "attendance",
    values: { ...payload, scannedAt, source: "mobile_verified", userId: scanUser.id },
  });

  const scanResult = await prisma.$transaction(async (transaction) => {
    const challenge = await transaction.attendanceChallenge.findFirst({
      include: { scan: { include: { office: true, user: true } } },
      where: {
        organizationId: currentUser.organizationId,
        tokenHash: hashToken(payload.challengeToken),
        userId: currentUser.id,
      },
    });
    if (!challenge) throw new ApiError(409, "Attendance check is invalid. Start again.");
    if (challenge.usedAt) {
      if (challenge.scan && challenge.scan.direction === direction) {
        return { replayed: true, scan: challenge.scan };
      }
      throw new ApiError(409, "Attendance check was already used. Start again.");
    }
    if (challenge.expiresAt <= new Date()) {
      throw new ApiError(409, "Attendance check expired. Start again.");
    }
    const claimed = await transaction.attendanceChallenge.updateMany({
      data: { usedAt: new Date() },
      where: { id: challenge.id, usedAt: null },
    });
    if (claimed.count !== 1) throw new ApiError(409, "Attendance check was already used.");
    const challengeId = challenge.id;

    const { end, start } = getDateRange(
      currentDateKey(currentUser.organization.timezone, scannedAt),
      currentUser.organization.timezone,
    );
    const previous = await transaction.attendanceScan.findFirst({
      orderBy: { scannedAt: "desc" },
      where: { accepted: true, scannedAt: { gte: start, lt: end }, userId: scanUser.id },
    });
    if (previous && scannedAt.getTime() - previous.scannedAt.getTime() < SCAN_COOLDOWN_MS) {
      throw new ApiError(429, "Please wait 30 seconds before another attendance scan.");
    }
    if (previous?.direction === direction) {
      throw new ApiError(409, `You are already checked ${direction === "IN" ? "in" : "out"}.`);
    }
    if (!previous && direction === "OUT") {
      throw new ApiError(409, "Check in before checking out.");
    }

    const created = await transaction.attendanceScan.create({
      data: {
        accepted: !rejectionReason,
        accuracyMeters: payload.accuracyMeters ?? null,
        challengeId,
        direction,
        distanceMeters: measuredDistance,
        latitude: payload.latitude ?? null,
        longitude: payload.longitude ?? null,
        officeId: nearestOffice?.id || null,
        organizationId: currentUser.organizationId,
        rejectionReason,
        scannedAt,
        source: "mobile_verified",
        userId: scanUser.id,
      },
      include: { office: true, user: true },
    });
    await transaction.auditLog.create({
      data: {
        action: created.accepted ? "RECORDED" : "REJECTED",
        actorId: currentUser.id,
        entityId: created.id,
        entityType: "ATTENDANCE",
        metadata: { direction: direction.toLowerCase(), officeId: created.officeId, source: created.source, userId: scanUser.id },
        organizationId: currentUser.organizationId,
        summary: `${created.accepted ? "Recorded" : "Rejected"} ${direction.toLowerCase()} attendance for ${scanUser.fullName}`,
      },
    });
    return { replayed: false, scan: created };
  });
  const scan = scanResult.scan;

  const savedCustomFields = scanResult.replayed
    ? await getSystemEntityData(currentUser, "attendance", scan.id)
    : await saveSystemEntityData({
        currentUser,
        entityId: scan.id,
        preparedData: customFields,
        systemKey: "attendance",
        values: payload.customFields,
      });
  return { ...serializeScan(scan), customFields: savedCustomFields, replayed: scanResult.replayed };
};

const serializeCorrection = (correction) => ({
  createdAt: correction.createdAt,
  direction: String(correction.requestedDirection).toLowerCase(),
  id: correction.id,
  reason: correction.reason,
  scanId: correction.scanId || "",
  requestedAt: correction.requestedAt,
  requester: correction.requester ? { id: correction.requester.id, name: correction.requester.fullName } : null,
  reviewNote: correction.reviewNote || "",
  reviewer: correction.reviewer ? { id: correction.reviewer.id, name: correction.reviewer.fullName } : null,
  status: String(correction.status).toLowerCase(),
});

const listCorrections = async (currentUser, { page, pageSize, status } = {}) => {
  const canViewAll = canManageAttendance(currentUser);
  const size = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const where = {
    organizationId: currentUser.organizationId,
    ...(canViewAll ? {} : { requesterId: currentUser.id }),
    ...(status && status !== "all" ? { status: String(status).toUpperCase() } : {}),
  };
  const total = await prisma.attendanceCorrection.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const corrections = await prisma.attendanceCorrection.findMany({
    include: { requester: true, reviewer: true },
    orderBy: { createdAt: "desc" },
    skip: (currentPage - 1) * size,
    take: size,
    where,
  });
  return {
    corrections: corrections.map(serializeCorrection),
    pagination: { page: currentPage, pageSize: size, total, totalPages },
  };
};

const createCorrection = async (currentUser, payload) => {
  const requestedAt = new Date(payload.requestedAt);
  if (Number.isNaN(requestedAt.getTime())) throw new ApiError(400, "Requested attendance time is invalid.");
  if (requestedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiError(400, "Attendance corrections cannot be requested for a future time.");
  }
  if (requestedAt.getTime() < Date.now() - CORRECTION_HISTORY_MS) {
    throw new ApiError(400, "Attendance corrections are limited to the previous 90 days.");
  }
  const correction = await prisma.$transaction(async (transaction) => {
    if (payload.scanId) {
      const scan = await transaction.attendanceScan.findFirst({
        select: { id: true },
        where: {
          id: payload.scanId,
          organizationId: currentUser.organizationId,
          userId: currentUser.id,
        },
      });
      if (!scan) throw new ApiError(404, "The selected attendance scan was not found.");
    }

    const created = await transaction.attendanceCorrection.create({
      data: {
        organizationId: currentUser.organizationId,
        reason: payload.reason,
        requestedAt,
        requestedDirection: normalizeDirection(payload.direction),
        requesterId: currentUser.id,
        scanId: payload.scanId || null,
      },
      include: { requester: true, reviewer: true },
    });
    await transaction.auditLog.create({
      data: {
        action: "REQUESTED",
        actorId: currentUser.id,
        entityId: created.id,
        entityType: "ATTENDANCE_CORRECTION",
        metadata: { direction: String(created.requestedDirection).toLowerCase(), requestedAt },
        organizationId: currentUser.organizationId,
        summary: `${currentUser.fullName} requested an attendance correction`,
      },
    });
    return created;
  });
  // Whoever actually holds attendance management, including custom roles.
  const reviewers = await findUsersWithPermission(currentUser.organizationId, PERMISSIONS.ATTENDANCE_MANAGE);
  await safelyNotify(() => createForRecipients({
    actor: currentUser,
    notification: {
      actionUrl: "/attendance",
      entityId: correction.id,
      entityType: "attendance_correction",
      message: `${currentUser.fullName} requested an attendance correction for ${requestedAt.toLocaleString("en")}.`,
      title: "Attendance correction requested",
      type: "ATTENDANCE_CORRECTION_REQUESTED",
    },
    recipientIds: reviewers.map(({ id }) => id),
  }));
  return serializeCorrection(correction);
};

const reviewCorrection = async (currentUser, correctionId, payload) => {
  if (!canManageAttendance(currentUser)) throw new ApiError(403, "You cannot review attendance corrections.");
  const correction = await prisma.attendanceCorrection.findFirst({
    where: { id: correctionId, organizationId: currentUser.organizationId },
  });
  if (!correction) throw new ApiError(404, "Attendance correction not found.");
  if (correction.status !== "PENDING") throw new ApiError(409, "This correction was already reviewed.");
  const status = String(payload.status).toUpperCase();

  await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.attendanceCorrection.updateMany({
      data: { reviewNote: payload.reviewNote || null, reviewedAt: new Date(), reviewerId: currentUser.id, status },
      where: { id: correctionId, organizationId: currentUser.organizationId, status: "PENDING" },
    });
    if (claimed.count !== 1) throw new ApiError(409, "This correction was already reviewed.");
    if (status === "APPROVED") {
      await transaction.attendanceScan.create({
        data: {
          accepted: true,
          direction: correction.requestedDirection,
          organizationId: currentUser.organizationId,
          scannedAt: correction.requestedAt,
          source: "approved_correction",
          userId: correction.requesterId,
        },
      });
    }
    await transaction.auditLog.create({
      data: {
        action: status,
        actorId: currentUser.id,
        entityId: correctionId,
        entityType: "ATTENDANCE_CORRECTION",
        metadata: { requesterId: correction.requesterId },
        organizationId: currentUser.organizationId,
        summary: `${status === "APPROVED" ? "Approved" : "Rejected"} attendance correction`,
      },
    });
  });
  const updated = await prisma.attendanceCorrection.findUnique({
    include: { requester: true, reviewer: true },
    where: { id: correctionId },
  });
  await safelyNotify(() => createForRecipients({
    actor: currentUser,
    notification: {
      actionUrl: "/attendance",
      entityId: correctionId,
      entityType: "attendance_correction",
      message: `${currentUser.fullName} ${status === "APPROVED" ? "approved" : "rejected"} your attendance correction.`,
      title: `Attendance correction ${status === "APPROVED" ? "approved" : "rejected"}`,
      type: `ATTENDANCE_CORRECTION_${status}`,
    },
    recipientIds: [correction.requesterId],
  }));
  return serializeCorrection(updated);
};

module.exports = {
  attendanceRules,
  createCorrection,
  currentDateKey,
  eachDateKey,
  getDateRange,
  createScan,
  getAttendanceSummary,
  issueChallenge,
  listOffices,
  listCorrections,
  listScans,
  reviewCorrection,
};
