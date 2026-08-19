const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createMeetingSchema,
  respondToMeetingSchema,
  updateMeetingSchema,
} = require("../src/utils/validators");
const { getRolePermissions, PERMISSIONS } = require("../src/utils/permissions");

/**
 * Mirrors the half-open overlap predicate the service hands to Prisma:
 * `endsAt > start AND startsAt < end`. Back-to-back meetings must not collide.
 */
const overlaps = (first, second) =>
  new Date(first.endsAt) > new Date(second.startsAt) &&
  new Date(first.startsAt) < new Date(second.endsAt);

const slot = (startHour, endHour) => ({
  endsAt: `2026-08-20T${String(endHour).padStart(2, "0")}:00:00.000Z`,
  startsAt: `2026-08-20T${String(startHour).padStart(2, "0")}:00:00.000Z`,
});

test("meeting payloads require a title and both ends of the time range", () => {
  const valid = createMeetingSchema.safeParse({
    attendeeIds: ["user-1", "user-2"],
    endsAt: "2026-08-20T11:00:00.000Z",
    startsAt: "2026-08-20T10:00:00.000Z",
    title: "Sprint review",
  });
  assert.equal(valid.success, true);

  assert.equal(createMeetingSchema.safeParse({ title: "Sprint review" }).success, false);
  assert.equal(
    createMeetingSchema.safeParse({ endsAt: "x", startsAt: "x", title: "a" }).success,
    false,
    "a one-character title should be rejected",
  );
});

test("a meeting link must be HTTPS when supplied", () => {
  const base = { endsAt: "2026-08-20T11:00:00.000Z", startsAt: "2026-08-20T10:00:00.000Z", title: "Standup" };

  assert.equal(createMeetingSchema.safeParse({ ...base, meetingUrl: "" }).success, true);
  assert.equal(
    createMeetingSchema.safeParse({ ...base, meetingUrl: "https://meet.example.com/abc" }).success,
    true,
  );
  assert.equal(
    createMeetingSchema.safeParse({ ...base, meetingUrl: "http://meet.example.com/abc" }).success,
    false,
  );
});

test("attendee lists are capped so an invite cannot fan out unbounded", () => {
  const base = { endsAt: "2026-08-20T11:00:00.000Z", startsAt: "2026-08-20T10:00:00.000Z", title: "All hands" };
  const ids = (count) => Array.from({ length: count }, (_, index) => `user-${index}`);

  assert.equal(createMeetingSchema.safeParse({ ...base, attendeeIds: ids(50) }).success, true);
  assert.equal(createMeetingSchema.safeParse({ ...base, attendeeIds: ids(51) }).success, false);
});

test("updates are partial, so one field can move without resending the meeting", () => {
  const result = updateMeetingSchema.safeParse({ title: "Renamed review" });
  assert.equal(result.success, true);
  assert.equal(result.data.startsAt, undefined);
});

test("only the three real answers are accepted as a response", () => {
  for (const response of ["accepted", "declined", "tentative", "ACCEPTED"]) {
    assert.equal(respondToMeetingSchema.safeParse({ response }).success, true);
  }
  assert.equal(respondToMeetingSchema.safeParse({ response: "maybe" }).success, false);
});

test("overlap detection catches real clashes and ignores back-to-back slots", () => {
  const existing = slot(10, 11);

  assert.equal(overlaps(existing, slot(10, 11)), true, "identical slots clash");
  assert.equal(overlaps(existing, slot(10, 12)), true, "a longer slot from the same start clashes");
  assert.equal(overlaps(existing, slot(9, 11)), true, "an earlier slot ending together clashes");
  assert.equal(overlaps(existing, slot(9, 12)), true, "a slot fully containing it clashes");

  // The boundary case: a meeting starting exactly when another ends is fine.
  assert.equal(overlaps(existing, slot(11, 12)), false, "back-to-back does not clash");
  assert.equal(overlaps(existing, slot(9, 10)), false, "ending exactly at the start does not clash");
  assert.equal(overlaps(existing, slot(13, 14)), false, "a distant slot does not clash");
});

test("meeting administration is granted to the roles that already run delivery", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN", "MANAGER", "HR"]) {
    assert.ok(
      getRolePermissions(role).includes(PERMISSIONS.MEETINGS_MANAGE),
      `${role} should administer meetings`,
    );
  }

  for (const role of ["ACCOUNTS", "EMPLOYEE"]) {
    assert.equal(
      getRolePermissions(role).includes(PERMISSIONS.MEETINGS_MANAGE),
      false,
      `${role} should only manage their own meetings`,
    );
  }
});
