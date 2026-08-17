-- Workspace roles become data instead of a fixed enum, so admins can define their own.
-- The legacy users.role enum column is intentionally left in place: it still acts as a
-- fail-closed fallback and keeps a rollback possible without data loss.

CREATE TABLE IF NOT EXISTS "roles" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "rank" INTEGER NOT NULL DEFAULT 50,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "roles_organizationId_key_key" ON "roles" ("organizationId", "key");
CREATE INDEX IF NOT EXISTS "roles_organizationId_rank_idx" ON "roles" ("organizationId", "rank");

ALTER TABLE "roles"
  ADD CONSTRAINT "roles_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "roleId" TEXT;

ALTER TABLE "users"
  ADD CONSTRAINT "users_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "users_roleId_idx" ON "users" ("roleId");

-- Seed the six system roles for every existing organization. Permission sets mirror
-- ROLE_PERMISSIONS in src/utils/permissions.js.
INSERT INTO "roles" ("id", "organizationId", "key", "name", "description", "permissions", "isSystem", "rank", "createdAt", "updatedAt")
SELECT
  md5(o."id" || ':' || seed."key")::text,
  o."id",
  seed."key",
  seed."name",
  seed."description",
  seed."permissions",
  true,
  seed."rank",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN (
  VALUES
    (
      'super_admin', 'Super Admin', 'Full control of the workspace, including billing and customization.',
      ARRAY[
        'dashboard.view','reports.view','tasks.view_all','tasks.create','tasks.edit','tasks.delete',
        'projects.view_all','projects.create','projects.edit','projects.delete',
        'attendance.view_all','attendance.manage','users.view','users.manage',
        'permissions.manage','settings.manage','customization.manage','audit.view','billing.manage'
      ]::TEXT[], 0
    ),
    (
      'admin', 'Admin', 'Manages people, delivery, and workspace settings.',
      ARRAY[
        'dashboard.view','reports.view','tasks.view_all','tasks.create','tasks.edit','tasks.delete',
        'projects.view_all','projects.create','projects.edit','projects.delete',
        'attendance.view_all','attendance.manage','users.view','users.manage',
        'permissions.manage','settings.manage','audit.view'
      ]::TEXT[], 10
    ),
    (
      'manager', 'Manager', 'Runs delivery across tasks and projects.',
      ARRAY[
        'dashboard.view','reports.view','tasks.view_all','tasks.create','tasks.edit','tasks.delete',
        'projects.view_all','projects.create','projects.edit','projects.delete'
      ]::TEXT[], 20
    ),
    (
      'hr', 'HR', 'Manages people, attendance, and workforce reporting.',
      ARRAY[
        'dashboard.view','reports.view','tasks.view_all','tasks.create','tasks.edit',
        'projects.view_all','projects.create','projects.edit',
        'attendance.view_all','attendance.manage','users.view','users.manage'
      ]::TEXT[], 20
    ),
    (
      'accounts', 'Accounts', 'Read-only visibility across delivery and attendance.',
      ARRAY['reports.view','tasks.view_all','projects.view_all','attendance.view_all']::TEXT[], 30
    ),
    ('employee', 'Employee', 'Works on assigned tasks.', ARRAY[]::TEXT[], 40)
) AS seed("key", "name", "description", "permissions", "rank")
ON CONFLICT ("organizationId", "key") DO NOTHING;

-- Point every existing user at the seeded role matching their legacy enum value.
UPDATE "users" u
SET "roleId" = r."id"
FROM "roles" r
WHERE r."organizationId" = u."organizationId"
  AND r."key" = lower(u."role"::text)
  AND u."roleId" IS NULL;
