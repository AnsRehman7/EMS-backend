-- AI-planned tasks begin without an assignee and remain available if an assignee is removed.
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assignedToId_fkey";

ALTER TABLE "tasks" ALTER COLUMN "assignedToId" DROP NOT NULL;

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_assignedToId_fkey"
FOREIGN KEY ("assignedToId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
