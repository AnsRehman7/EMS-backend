-- CreateEnum
CREATE TYPE "AttendanceDirection" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "attendance_scans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "AttendanceDirection" NOT NULL,
    "source" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracyMeters" DECIMAL(8,2),
    "distanceMeters" DECIMAL(8,2),
    "accepted" BOOLEAN NOT NULL DEFAULT true,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_scans_organizationId_scannedAt_idx" ON "attendance_scans"("organizationId", "scannedAt");

-- CreateIndex
CREATE INDEX "attendance_scans_userId_scannedAt_idx" ON "attendance_scans"("userId", "scannedAt");

-- AddForeignKey
ALTER TABLE "attendance_scans" ADD CONSTRAINT "attendance_scans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_scans" ADD CONSTRAINT "attendance_scans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
