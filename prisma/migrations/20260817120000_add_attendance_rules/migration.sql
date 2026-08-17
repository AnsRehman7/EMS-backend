-- Attendance rules move from the attendance module UI into workspace settings.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "checkInGraceMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "checkoutWindowStart" TEXT NOT NULL DEFAULT '16:00',
  ADD COLUMN IF NOT EXISTS "checkoutWindowEnd" TEXT NOT NULL DEFAULT '18:00',
  ADD COLUMN IF NOT EXISTS "minimumOfficeMinutes" INTEGER NOT NULL DEFAULT 360;
