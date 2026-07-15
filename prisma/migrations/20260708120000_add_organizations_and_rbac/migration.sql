-- ExtendRoleEnum
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'MANAGER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ACCOUNTS';

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "BillingPlan" AS ENUM ('FREE_TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'TRIAL',
    "plan" "BillingPlan" NOT NULL DEFAULT 'FREE_TRIAL',
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE INDEX "organizations_plan_idx" ON "organizations"("plan");

-- Backfill a workspace only when existing single-tenant rows are present.
INSERT INTO "organizations" ("id", "name", "slug", "status", "plan", "trialEndsAt", "createdAt", "updatedAt")
SELECT 'legacy_workspace', 'Legacy Workspace', 'legacy-workspace', 'TRIAL', 'FREE_TRIAL', CURRENT_TIMESTAMP + INTERVAL '14 days', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "users");

-- AlterUsers
ALTER TABLE "users"
ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "designation" TEXT,
ADD COLUMN "department" TEXT,
ADD COLUMN "organizationId" TEXT,
ADD COLUMN "invitedById" TEXT;

UPDATE "users"
SET "organizationId" = 'legacy_workspace'
WHERE "organizationId" IS NULL;

ALTER TABLE "users" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterProjects
ALTER TABLE "projects" ADD COLUMN "organizationId" TEXT;

UPDATE "projects"
SET "organizationId" = "users"."organizationId"
FROM "users"
WHERE "projects"."createdById" = "users"."id"
  AND "projects"."organizationId" IS NULL;

ALTER TABLE "projects" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTasks
ALTER TABLE "tasks" ADD COLUMN "organizationId" TEXT;

UPDATE "tasks"
SET "organizationId" = "projects"."organizationId"
FROM "projects"
WHERE "tasks"."projectId" = "projects"."id"
  AND "tasks"."organizationId" IS NULL;

UPDATE "tasks"
SET "organizationId" = "users"."organizationId"
FROM "users"
WHERE "tasks"."createdById" = "users"."id"
  AND "tasks"."organizationId" IS NULL;

ALTER TABLE "tasks" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "users_organizationId_role_idx" ON "users"("organizationId", "role");

-- CreateIndex
CREATE INDEX "users_organizationId_status_idx" ON "users"("organizationId", "status");

-- CreateIndex
CREATE INDEX "users_invitedById_idx" ON "users"("invitedById");

-- CreateIndex
CREATE INDEX "projects_organizationId_status_idx" ON "projects"("organizationId", "status");

-- CreateIndex
CREATE INDEX "tasks_organizationId_status_idx" ON "tasks"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
