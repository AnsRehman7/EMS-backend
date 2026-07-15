const prisma = require("../db/prisma");
const { env } = require("../config/env");
const ApiError = require("../utils/apiError");
const { canManageAttendance, canViewOrganizationAttendance } = require("../utils/roles");

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));
const normalizeDirection = (direction) => String(direction || "").trim().toUpperCase();

const parseDate = (value, label) => {
  if (!value) return new Date();

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, `${label} must be a valid date.`);
  }

  return parsed;
};

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const calculateDistanceMeters = ({ latitude, longitude }) => {
  if (
    env.officeLatitude === undefined ||
    env.officeLongitude === undefined ||
    latitude === undefined ||
    longitude === undefined
  ) {
    return null;
  }

  const earthRadiusMeters = 6371000;
  const deltaLatitude = toRadians(latitude - env.officeLatitude);
  const deltaLongitude = toRadians(longitude - env.officeLongitude);
  const startLatitude = toRadians(env.officeLatitude);
  const endLatitude = toRadians(latitude);
  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(deltaLongitude / 2) *
      Math.sin(deltaLongitude / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(earthRadiusMeters * c * 100) / 100;
};

const serializeScan = (scan) => ({
  accepted: scan.accepted,
  accuracyMeters: toNumber(scan.accuracyMeters),
  createdAt: scan.createdAt,
  direction: String(scan.direction).toLowerCase(),
  distanceMeters: toNumber(scan.distanceMeters),
  id: scan.id,
  latitude: toNumber(scan.latitude),
  longitude: toNumber(scan.longitude),
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

const getDateRange = (date) => {
  const base = date ? new Date(`${date}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) {
    throw new ApiError(400, "Date must be a valid YYYY-MM-DD value.");
  }

  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return { end, start };
};

const listScans = async (currentUser, { date } = {}) => {
  const { end, start } = getDateRange(date);
  const canViewAll = canViewOrganizationAttendance(currentUser);

  const scans = await prisma.attendanceScan.findMany({
    include: {
      user: true,
    },
    orderBy: { scannedAt: "asc" },
    where: {
      organizationId: currentUser.organizationId,
      scannedAt: {
        gte: start,
        lt: end,
      },
      ...(canViewAll ? {} : { userId: currentUser.id }),
    },
  });

  return scans.map(serializeScan);
};

const resolveScanUser = async (currentUser, requestedUserId) => {
  if (!requestedUserId || requestedUserId === currentUser.id) return currentUser;

  if (!canManageAttendance(currentUser)) {
    throw new ApiError(403, "You can only mark attendance for your own account.");
  }

  const user = await prisma.user.findFirst({
    where: {
      id: requestedUserId,
      organizationId: currentUser.organizationId,
      status: "ACTIVE",
    },
  });

  if (!user) {
    throw new ApiError(404, "Attendance user not found.");
  }

  return user;
};

const createScan = async (currentUser, payload) => {
  const scanUser = await resolveScanUser(currentUser, payload.userId);
  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const source = payload.source || "mobile_fingerprint";
  const isMobileScan = source.toLowerCase().includes("mobile");
  const distanceMeters = calculateDistanceMeters({ latitude, longitude });
  const geofenceConfigured = env.officeLatitude !== undefined && env.officeLongitude !== undefined;
  const missingMobileLocation = geofenceConfigured && isMobileScan && distanceMeters === null;
  const accepted = !missingMobileLocation && (distanceMeters === null || distanceMeters <= env.officeRadiusMeters);
  const rejectionReason = missingMobileLocation
    ? "Mobile attendance requires a valid office location check."
    : geofenceConfigured && !accepted
      ? `Outside office geofence by ${Math.round(distanceMeters - env.officeRadiusMeters)} meters.`
      : null;

  const scan = await prisma.attendanceScan.create({
    data: {
      accepted,
      accuracyMeters: payload.accuracyMeters ?? null,
      direction: normalizeDirection(payload.direction),
      distanceMeters,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      organizationId: currentUser.organizationId,
      rejectionReason,
      scannedAt: parseDate(payload.scannedAt, "Scan time"),
      source,
      userId: scanUser.id,
    },
    include: {
      user: true,
    },
  });

  return serializeScan(scan);
};

module.exports = {
  createScan,
  listScans,
};
