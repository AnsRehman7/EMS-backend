-- AlterProjects
ALTER TABLE "projects"
ADD COLUMN "aiProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "aiSummary" TEXT,
ADD COLUMN "aiAnalyzedAt" TIMESTAMP(3);

-- AlterTasks
ALTER TABLE "tasks"
ADD COLUMN "projectWeight" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN "aiProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "aiSummary" TEXT,
ADD COLUMN "aiAnalyzedAt" TIMESTAMP(3);

-- AlterTimeLogs
ALTER TABLE "time_logs"
ADD COLUMN "aiProgressAfter" INTEGER,
ADD COLUMN "analysisSummary" TEXT;

-- Backfill completed work as fully progressed.
UPDATE "tasks"
SET "aiProgress" = 100,
    "aiAnalyzedAt" = CURRENT_TIMESTAMP,
    "aiSummary" = 'Marked complete before AI progress tracking was enabled.'
WHERE "status" = 'COMPLETED';
