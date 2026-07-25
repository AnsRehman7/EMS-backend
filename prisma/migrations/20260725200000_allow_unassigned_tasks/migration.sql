-- AI-generated tasks and draft tasks may remain unassigned until a manager assigns them.
UPDATE "custom_field_definitions" AS field
SET
    "isRequired" = false,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "module_definitions" AS module
WHERE
    field."moduleId" = module."id"
    AND module."systemKey" = 'tasks'
    AND field."systemFieldKey" = 'assignedToId';
