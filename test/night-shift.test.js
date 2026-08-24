const test = require("node:test");
const assert = require("node:assert/strict");
const {
  businessDateKey,
  crossesMidnight,
  minutesLate,
  withinWindow,
} = require("../src/services/attendanceVerification.service");
const { updateWorkspaceSettingsSchema } = require("../src/utils/validators");

// 23:00 to 06:00, with checkout allowed until 07:00.
const nightRules = {
  checkoutWindowEnd: "07:00",
  checkoutWindowStart: "05:00",
  officeEnd: "06:00",
  officeStart: "23:00",
};
const dayRules = {
  checkoutWindowEnd: "18:00",
  checkoutWindowStart: "16:00",
  officeEnd: "18:00",
  officeStart: "09:00",
};

const at = (hours, minutes = 0) => hours * 60 + minutes;

test("a shift is recognised as overnight only when it wraps past midnight", () => {
  assert.equal(crossesMidnight("23:00", "06:00"), true);
  assert.equal(crossesMidnight("09:00", "18:00"), false);
  assert.equal(crossesMidnight("00:00", "23:59"), false);
});

test("an overnight shift keeps one night on a single business day", () => {
  // The whole shift must land on the day it started, or a night reads as two
  // half-days: one with no checkout and one with no check-in.
  assert.equal(businessDateKey("2026-08-24", at(23, 30), nightRules), "2026-08-24");
  assert.equal(businessDateKey("2026-08-25", at(1), nightRules), "2026-08-24");
  assert.equal(businessDateKey("2026-08-25", at(5, 30), nightRules), "2026-08-24");
});

test("the checkout window extends how late a scan can still count for last night", () => {
  // 06:30 is past the shift end but inside the 05:00-07:00 checkout window.
  assert.equal(businessDateKey("2026-08-25", at(6, 30), nightRules), "2026-08-24");
  // Well past both, so it belongs to the new day.
  assert.equal(businessDateKey("2026-08-25", at(9), nightRules), "2026-08-25");
});

test("a normal daytime shift is never re-attributed", () => {
  assert.equal(businessDateKey("2026-08-24", at(9, 15), dayRules), "2026-08-24");
  assert.equal(businessDateKey("2026-08-24", at(1), dayRules), "2026-08-24");
  assert.equal(businessDateKey("2026-08-24", at(17), dayRules), "2026-08-24");
});

test("lateness is measured around the clock for an overnight start", () => {
  // Shift starts 23:00 with 60 minutes grace, so the threshold is midnight.
  assert.equal(minutesLate(at(22, 50), "23:00", 60), 0, "arriving early is not late");
  assert.equal(minutesLate(at(23, 30), "23:00", 60), 0, "inside the grace period");
  assert.equal(minutesLate(at(0, 30), "23:00", 60), 30, "30 minutes past midnight");
  assert.equal(minutesLate(at(2), "23:00", 60), 120);
});

test("lateness still works for a daytime shift", () => {
  assert.equal(minutesLate(at(9, 5), "09:00", 15), 0);
  assert.equal(minutesLate(at(9, 45), "09:00", 15), 30);
  assert.equal(minutesLate(at(8, 30), "09:00", 15), 0);
});

test("a checkout window may wrap past midnight", () => {
  assert.equal(withinWindow(at(23, 30), "23:00", "02:00"), true);
  assert.equal(withinWindow(at(1), "23:00", "02:00"), true);
  assert.equal(withinWindow(at(12), "23:00", "02:00"), false);

  // Ordinary windows are unchanged.
  assert.equal(withinWindow(at(17), "16:00", "18:00"), true);
  assert.equal(withinWindow(at(9), "16:00", "18:00"), false);
});

test("workspace settings accept a night shift but reject a zero-length day", () => {
  assert.equal(
    updateWorkspaceSettingsSchema.safeParse({ workdayEnd: "06:00", workdayStart: "23:00" }).success,
    true,
    "23:00 to 06:00 is a valid night shift",
  );
  assert.equal(
    updateWorkspaceSettingsSchema.safeParse({ workdayEnd: "18:00", workdayStart: "09:00" }).success,
    true,
  );
  assert.equal(
    updateWorkspaceSettingsSchema.safeParse({ workdayEnd: "09:00", workdayStart: "09:00" }).success,
    false,
    "identical times are a zero-length day",
  );
});
