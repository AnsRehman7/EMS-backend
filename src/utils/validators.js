const { z } = require("zod");

const optionalTrimmedString = (max = 255) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));

const optionalNumber = (max = 9999) =>
  z.preprocess(
    (value) => {
      if (value === "" || value === null || value === undefined) return undefined;
      return Number(value);
    },
    z.number().finite().nonnegative().max(max).optional()
  );

const optionalNullableNumber = (max = 9999) =>
  z.preprocess(
    (value) => {
      if (value === "" || value === null) return null;
      if (value === undefined) return undefined;
      return Number(value);
    },
    z.number().finite().nonnegative().max(max).nullable().optional()
  );

const optionalNullableId = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().min(1, "Choose a valid assignee.").nullable().optional()
);

const requiredNumber = (max = 9999) =>
  z.preprocess((value) => Number(value), z.number().finite().positive().max(max));

const optionalBoundedNumber = (min, max) =>
  z.preprocess(
    (value) => {
      if (value === "" || value === null || value === undefined) return undefined;
      return Number(value);
    },
    z.number().finite().min(min).max(max).optional()
  );

const roleValues = [
  "super_admin",
  "admin",
  "manager",
  "hr",
  "accounts",
  "employee",
  "SUPER_ADMIN",
  "ADMIN",
  "MANAGER",
  "HR",
  "ACCOUNTS",
  "EMPLOYEE",
];

const taskStatusValues = [
  "new",
  "open",
  "active",
  "in_progress",
  "completed",
  "NEW",
  "ACTIVE",
  "IN_PROGRESS",
  "COMPLETED",
];

const projectPriorityValues = ["low", "normal", "high", "critical", "LOW", "NORMAL", "HIGH", "CRITICAL"];
const permissionKeySchema = z.string().trim().min(1).max(80);
const projectTagsSchema = z.array(z.string().trim().min(1).max(40)).max(12);
const workspaceDepartmentsSchema = z.array(z.string().trim().min(1).max(80)).max(40);
const moduleRoleSchema = z.enum(roleValues);
const moduleRolesSchema = z.array(moduleRoleSchema).max(6);
const customFieldTypeSchema = z.enum([
  "text",
  "long_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "email",
  "phone",
  "url",
  "select",
  "multi_select",
  "user",
  "TEXT",
  "LONG_TEXT",
  "INTEGER",
  "DECIMAL",
  "BOOLEAN",
  "DATE",
  "DATETIME",
  "EMAIL",
  "PHONE",
  "URL",
  "SELECT",
  "MULTI_SELECT",
  "USER",
]);
const customFieldOptionSchema = z.union([
  z.string().trim().min(1).max(120),
  z.object({
    label: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(120),
  }),
]);
const customFieldBaseSchema = z.object({
  defaultValue: z.unknown().optional(),
  description: optionalTrimmedString(500),
  isRequired: z.boolean(),
  isVisible: z.boolean(),
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "Field key must use lowercase letters, numbers, and underscores."),
  label: z.string().trim().min(1, "Field label is required.").max(120),
  options: z.array(customFieldOptionSchema).max(100).optional(),
  placeholder: optionalTrimmedString(160),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
  type: customFieldTypeSchema,
  validation: z
    .object({
      max: z.coerce.number().finite().optional(),
      maxLength: z.coerce.number().int().positive().max(100000).optional(),
      min: z.coerce.number().finite().optional(),
      minLength: z.coerce.number().int().nonnegative().max(100000).optional(),
    })
    .optional(),
});
const customFieldInputSchema = customFieldBaseSchema.extend({
  isRequired: z.boolean().default(false),
  isVisible: z.boolean().default(true),
});
const customValuesSchema = z.record(z.string().max(64), z.unknown());

const syncProfileSchema = z.object({
  contact: optionalTrimmedString(40),
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  fullName: optionalTrimmedString(120),
  organizationName: optionalTrimmedString(160),
  role: optionalTrimmedString(30),
});

const createOrganizationUserSchema = z.object({
  contact: optionalTrimmedString(40),
  customFields: customValuesSchema.default({}),
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  email: z.string().trim().email("Enter a valid email address.").max(255),
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
  password: z.string().min(6, "Password must be at least 6 characters.").max(128),
  role: z.enum(roleValues).default("employee"),
});

const updateOrganizationUserSchema = z.object({
  contact: optionalTrimmedString(40),
  customFields: customValuesSchema.optional(),
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  email: z.string().trim().email("Enter a valid email address.").max(255).optional(),
  fullName: optionalTrimmedString(120),
  password: z.string().min(6, "Password must be at least 6 characters.").max(128).optional(),
  role: z.enum(roleValues).optional(),
  status: z.enum(["active", "suspended", "ACTIVE", "SUSPENDED"]).optional(),
});

const createProjectSchema = z
  .object({
    clientName: optionalTrimmedString(160),
    code: optionalTrimmedString(32),
    customFields: customValuesSchema.default({}),
    department: optionalTrimmedString(120),
    description: optionalTrimmedString(5000),
    dueDate: optionalTrimmedString(40),
    estimatedHours: optionalNumber(999999.99),
    generateTasksWithAi: z.boolean().default(false),
    name: z.string().trim().min(1, "Project name is required.").max(160),
    objective: optionalTrimmedString(5000),
    ownerId: optionalTrimmedString(80),
    priority: z.enum(projectPriorityValues).default("normal"),
    startDate: optionalTrimmedString(40),
    status: z.enum(["planned", "active", "PLANNED", "ACTIVE"]).optional(),
    tags: projectTagsSchema.default([]),
  })
  .superRefine((project, context) => {
    if (!project.generateTasksWithAi) return;

    if (!project.description || project.description.length < 40) {
      context.addIssue({
        code: "custom",
        message: "Add at least 40 characters of project requirements for AI task planning.",
        path: ["description"],
      });
    }

    if (!project.dueDate) {
      context.addIssue({
        code: "custom",
        message: "Set a project due date so Groq can schedule the generated tasks.",
        path: ["dueDate"],
      });
    }
  });

const updateProjectSchema = z.object({
  clientName: z.string().trim().max(160).optional(),
  code: z.string().trim().max(32).optional(),
  customFields: customValuesSchema.optional(),
  department: z.string().trim().max(120).optional(),
  description: z.string().trim().max(5000).optional(),
  dueDate: z.string().trim().max(40).optional(),
  estimatedHours: optionalNullableNumber(999999.99),
  name: optionalTrimmedString(160),
  objective: z.string().trim().max(5000).optional(),
  ownerId: optionalNullableId,
  priority: z.enum(projectPriorityValues).optional(),
  startDate: z.string().trim().max(40).optional(),
  status: z.enum(["planned", "active", "completed", "archived", "PLANNED", "ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
  tags: projectTagsSchema.optional(),
});

const createTaskSchema = z.object({
  assignedToId: z.string().trim().min(1, "Choose an employee before creating the task."),
  category: z.string().trim().min(1, "Category is required.").max(80),
  customFields: customValuesSchema.default({}),
  deadline: optionalTrimmedString(40),
  description: z.string().trim().min(1, "Description is required.").max(5000),
  estimatedHours: optionalNumber(999.99),
  priority: z.enum(["low", "normal", "high", "LOW", "NORMAL", "HIGH"]).default("normal"),
  projectId: z.string().trim().min(1, "Choose a project before creating the task."),
  successCriteria: optionalTrimmedString(5000),
  status: z.enum(taskStatusValues).default("open"),
  title: z.string().trim().min(1, "Task title is required.").max(160),
});

const updateTaskSchema = z.object({
  assignedToId: optionalNullableId,
  category: z.string().trim().min(1, "Category is required.").max(80).optional(),
  customFields: customValuesSchema.optional(),
  deadline: z.string().trim().max(40).optional(),
  description: z.string().trim().min(1, "Description is required.").max(5000).optional(),
  estimatedHours: optionalNullableNumber(999.99),
  priority: z.enum(["low", "normal", "high", "LOW", "NORMAL", "HIGH"]).optional(),
  projectId: z.string().trim().min(1, "Choose a valid project.").optional(),
  status: z.enum(taskStatusValues).optional(),
  successCriteria: z.string().trim().max(5000).optional(),
  title: z.string().trim().min(1, "Task title is required.").max(160).optional(),
});

const createTimeLogSchema = z.object({
  hours: requiredNumber(999.99),
  loggedAt: optionalTrimmedString(40),
  note: optionalTrimmedString(1000),
});

const createAttendanceScanSchema = z.object({
  accuracyMeters: optionalNumber(9999),
  customFields: customValuesSchema.default({}),
  direction: z.enum(["in", "out", "IN", "OUT"]),
  latitude: optionalBoundedNumber(-90, 90),
  longitude: optionalBoundedNumber(-180, 180),
  scannedAt: optionalTrimmedString(40),
  source: optionalTrimmedString(80),
  userId: optionalTrimmedString(80),
});

const updateTaskStatusSchema = z.object({
  status: z.enum(taskStatusValues),
});

const updateUserRoleSchema = z.object({
  role: z.enum(roleValues),
});

const updateCurrentProfileSchema = z.object({
  contact: optionalTrimmedString(40),
  customFields: customValuesSchema.optional(),
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
});

const updateUserPermissionsSchema = z.object({
  permissions: z.array(permissionKeySchema).max(50).default([]),
  useRoleDefaults: z.boolean().default(false),
});

const updateWorkspaceSettingsSchema = z
  .object({
    departments: workspaceDepartmentsSchema.optional(),
    name: z.string().trim().min(2, "Workspace name must contain at least 2 characters.").max(160).optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    weekStartsOn: z.coerce.number().int().min(0).max(6).optional(),
    workdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm for the workday end.").optional(),
    workdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm for the workday start.").optional(),
  })
  .superRefine((settings, context) => {
    if (settings.workdayStart && settings.workdayEnd && settings.workdayStart >= settings.workdayEnd) {
      context.addIssue({
        code: "custom",
        message: "Workday end must be later than workday start.",
        path: ["workdayEnd"],
      });
    }
  });

const createModuleSchema = z.object({
  createRoles: moduleRolesSchema.default(roleValues.slice(0, 6)),
  deleteRoles: moduleRolesSchema.default(["super_admin", "admin"]),
  description: optionalTrimmedString(500),
  editRoles: moduleRolesSchema.default(roleValues.slice(0, 6)),
  fields: z.array(customFieldInputSchema).min(1, "Add at least one field.").max(100),
  icon: optionalTrimmedString(40),
  key: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[a-z][a-z0-9-]*$/, "Module key must use lowercase letters, numbers, and hyphens."),
  pluralName: z.string().trim().min(1, "Plural module name is required.").max(80),
  singularName: z.string().trim().min(1, "Module name is required.").max(80),
  viewRoles: moduleRolesSchema.default(roleValues.slice(0, 6)),
});

const updateModuleSchema = z.object({
  createRoles: moduleRolesSchema.optional(),
  deleteRoles: moduleRolesSchema.optional(),
  description: z.string().trim().max(500).optional(),
  editRoles: moduleRolesSchema.optional(),
  icon: z.string().trim().min(1).max(40).optional(),
  pluralName: z.string().trim().min(1).max(80).optional(),
  primaryFieldId: z.string().trim().min(1).max(80).nullable().optional(),
  singularName: z.string().trim().min(1).max(80).optional(),
  status: z.enum(["active", "archived", "ACTIVE", "ARCHIVED"]).optional(),
  viewRoles: moduleRolesSchema.optional(),
});

const updateCustomFieldSchema = customFieldBaseSchema.partial().extend({
  archived: z.boolean().optional(),
});

const customRecordSchema = z.object({
  values: customValuesSchema.default({}),
});

const parseBody = (schema, body) => schema.parse(body || {});

module.exports = {
  createAttendanceScanSchema,
  createModuleSchema,
  createOrganizationUserSchema,
  createProjectSchema,
  createTaskSchema,
  createTimeLogSchema,
  customFieldInputSchema,
  customRecordSchema,
  parseBody,
  syncProfileSchema,
  updateCurrentProfileSchema,
  updateCustomFieldSchema,
  updateModuleSchema,
  updateOrganizationUserSchema,
  updateProjectSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  updateUserRoleSchema,
  updateUserPermissionsSchema,
  updateWorkspaceSettingsSchema,
};
