-- Extend the task workflow without changing existing NEW records.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
