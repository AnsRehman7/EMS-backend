-- Meetings: scheduled time with attendees, optionally tied to the project or task
-- the time is being spent on.

CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "AttendeeResponse" AS ENUM ('INVITED', 'ACCEPTED', 'DECLINED', 'TENTATIVE');

CREATE TABLE "meetings" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "agenda" TEXT,
  "location" TEXT,
  "meetingUrl" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
  "organizerId" TEXT NOT NULL,
  "projectId" TEXT,
  "taskId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_attendees" (
  "id" TEXT NOT NULL,
  "meetingId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "response" "AttendeeResponse" NOT NULL DEFAULT 'INVITED',
  "respondedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "meeting_attendees_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meetings_organizationId_startsAt_idx" ON "meetings" ("organizationId", "startsAt");
CREATE INDEX "meetings_organizerId_startsAt_idx" ON "meetings" ("organizerId", "startsAt");
CREATE INDEX "meetings_projectId_idx" ON "meetings" ("projectId");
CREATE UNIQUE INDEX "meeting_attendees_meetingId_userId_key" ON "meeting_attendees" ("meetingId", "userId");
CREATE INDEX "meeting_attendees_userId_idx" ON "meeting_attendees" ("userId");

ALTER TABLE "meetings"
  ADD CONSTRAINT "meetings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "meetings_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "meetings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "meetings_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "meeting_attendees"
  ADD CONSTRAINT "meeting_attendees_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "meeting_attendees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Everyone may organize their own meetings; this permission covers managing anyone
-- else's. Granted to the seeded roles that already administer work.
UPDATE "roles"
SET "permissions" = array_append("permissions", 'meetings.manage')
WHERE "isSystem" = true
  AND "key" IN ('super_admin', 'admin', 'manager', 'hr')
  AND NOT ('meetings.manage' = ANY("permissions"));
