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
  "blocked",
  "completed",
  "NEW",
  "ACTIVE",
  "IN_PROGRESS",
  "BLOCKED",
  "COMPLETED",
];

const projectPriorityValues = ["low", "normal", "high", "critical", "LOW", "NORMAL", "HIGH", "CRITICAL"];
const permissionKeySchema = z.string().trim().min(1).max(80);
const projectTagsSchema = z.array(z.string().trim().min(1).max(40)).max(12);
const skillsSchema = z.array(z.string().trim().min(1).max(80)).max(30);
const isDateOnly = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const normalizeRequirementKey = (value, index) =>
  String(value || `REQ-${String(index + 1).padStart(3, "0")}`)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
const secureUrlSchema = (message) =>
  z.string().trim().url(message).max(2048).refine(
    (value) => new URL(value).protocol === "https:",
    "URL must use HTTPS.",
  );
const avatarUrlSchema = z.union([
  z.literal(""),
  secureUrlSchema("Avatar must be a valid URL."),
]);
const requirementInputSchema = z.object({
  acceptanceCriteria: optionalTrimmedString(2000),
  description: z.string().trim().min(1, "Requirement description is required.").max(5000),
  key: optionalTrimmedString(30),
  priority: z.enum(["must", "should", "could", "wont", "MUST", "SHOULD", "COULD", "WONT"]).default("must"),
  source: optionalTrimmedString(40),
  title: z.string().trim().min(1, "Requirement title is required.").max(160),
});
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
  avatarUrl: avatarUrlSchema.optional(),
  contact: optionalTrimmedString(40),
  customFields: customValuesSchema.default({}),
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  email: z.string().trim().email("Enter a valid email address.").max(255),
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
  password: z.string().min(12, "Temporary passwords must be at least 12 characters.").max(128).optional(),
  role: z.enum(roleValues).default("employee"),
  skills: skillsSchema.default([]),
  weeklyCapacityHours: z.coerce.number().positive().max(168).default(40),
});

const updateOrganizationUserSchema = z.object({
  avatarUrl: avatarUrlSchema.optional(),
  contact: optionalTrimmedString(40),
  customFields: customValuesSchema.optional(),
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  email: z.string().trim().email("Enter a valid email address.").max(255).optional(),
  fullName: optionalTrimmedString(120),
  password: z.string().min(12, "Passwords must be at least 12 characters.").max(128).optional(),
  role: z.enum(roleValues).optional(),
  skills: skillsSchema.optional(),
  status: z.enum(["active", "suspended", "ACTIVE", "SUSPENDED"]).optional(),
  weeklyCapacityHours: z.coerce.number().positive().max(168).optional(),
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
    requirements: z.array(requirementInputSchema).max(40).default([]),
    startDate: optionalTrimmedString(40),
    status: z.enum(["planned", "active", "PLANNED", "ACTIVE"]).optional(),
    tags: projectTagsSchema.default([]),
  })
  .superRefine((project, context) => {
    const requirementKeys = project.requirements.map((requirement, index) =>
      normalizeRequirementKey(requirement.key, index),
    );
    if (new Set(requirementKeys).size !== requirementKeys.length) {
      context.addIssue({
        code: "custom",
        message: "Requirement keys must be unique after normalization.",
        path: ["requirements"],
      });
    }

    if (!project.generateTasksWithAi) return;

    const structuredRequirementLength = project.requirements.reduce(
      (total, requirement) => total + requirement.title.length + requirement.description.length,
      0,
    );
    if ((!project.description || project.description.length < 40) && structuredRequirementLength < 40) {
      context.addIssue({
        code: "custom",
        message: "Add a detailed brief or structured requirements before generating a plan.",
        path: [project.requirements.length ? "requirements" : "description"],
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
  expectedVersion: z.coerce.number().int().positive().optional(),
  name: optionalTrimmedString(160),
  objective: z.string().trim().max(5000).optional(),
  ownerId: optionalNullableId,
  priority: z.enum(projectPriorityValues).optional(),
  startDate: z.string().trim().max(40).optional(),
  status: z.enum(["planned", "active", "completed", "archived", "PLANNED", "ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
  tags: projectTagsSchema.optional(),
});

const createTaskSchema = z.object({
  assignedToId: optionalNullableId,
  category: z.string().trim().min(1, "Category is required.").max(80),
  customFields: customValuesSchema.default({}),
  dependencyIds: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  deadline: optionalTrimmedString(40),
  description: z.string().trim().min(1, "Description is required.").max(5000),
  estimatedHours: optionalNumber(999.99),
  priority: z.enum(["low", "normal", "high", "LOW", "NORMAL", "HIGH"]).default("normal"),
  projectId: z.string().trim().min(1, "Choose a project before creating the task."),
  successCriteria: optionalTrimmedString(5000),
  status: z.enum(taskStatusValues).default("open"),
  requiredSkills: skillsSchema.default([]),
  riskLevel: z.enum(["low", "medium", "high", "critical", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("low"),
  title: z.string().trim().min(1, "Task title is required.").max(160),
});

const updateTaskSchema = z.object({
  assignedToId: optionalNullableId,
  category: z.string().trim().min(1, "Category is required.").max(80).optional(),
  customFields: customValuesSchema.optional(),
  dependencyIds: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  deadline: z.string().trim().max(40).optional(),
  description: z.string().trim().min(1, "Description is required.").max(5000).optional(),
  estimatedHours: optionalNullableNumber(999.99),
  expectedVersion: z.coerce.number().int().positive().optional(),
  priority: z.enum(["low", "normal", "high", "LOW", "NORMAL", "HIGH"]).optional(),
  projectId: z.string().trim().min(1, "Choose a valid project.").optional(),
  status: z.enum(taskStatusValues).optional(),
  requiredSkills: skillsSchema.optional(),
  riskLevel: z.enum(["low", "medium", "high", "critical", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
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
  challengeToken: z.string().trim().min(20).max(500).optional(),
  latitude: optionalBoundedNumber(-90, 90),
  longitude: optionalBoundedNumber(-180, 180),
  scannedAt: optionalTrimmedString(40),
  source: optionalTrimmedString(80),
  userId: optionalTrimmedString(80),
});

const updateTaskStatusSchema = z.object({
  expectedVersion: z.coerce.number().int().positive().optional(),
  status: z.enum(taskStatusValues),
});

const updateUserRoleSchema = z.object({
  role: z.enum(roleValues),
});

const updateCurrentProfileSchema = z.object({
  avatarUrl: avatarUrlSchema.optional(),
  contact: optionalTrimmedString(40),
  customFields: customValuesSchema.optional(),
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
  skills: skillsSchema.optional(),
  weeklyCapacityHours: z.coerce.number().positive().max(168).optional(),
});

const generateProjectPlanSchema = z.object({
  manualBaselineMinutes: z.coerce.number().int().positive().max(10080).optional(),
  requirements: z.array(requirementInputSchema).min(1).max(40).optional(),
});

const approveProjectPlanSchema = z.object({
  assignmentOverrides: z.record(z.string().max(30), z.string().trim().max(80).nullable()).default({}),
  manualBaselineMinutes: z.coerce.number().int().positive().max(10080).optional(),
  reviewDurationSeconds: z.coerce.number().int().positive().max(86400).optional(),
  useRecommendations: z.boolean().default(false),
});

const reviewProjectPlanSchema = z.object({
  notes: optionalTrimmedString(2000),
  reason: optionalTrimmedString(1000),
});

const createTaskCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty.").max(5000),
  mentions: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
});

const createTaskAttachmentSchema = z.object({
  mimeType: optionalTrimmedString(160),
  name: z.string().trim().min(1, "File name is required.").max(255),
  sizeBytes: z.coerce.number().int().nonnegative().max(100_000_000).optional(),
  url: secureUrlSchema("Attachment URL must be valid."),
});

const setTaskWatchingSchema = z.object({ watching: z.boolean() });

const createPushSubscriptionSchema = z.object({
  deviceName: optionalTrimmedString(120),
  platform: z.enum(["web", "android", "ios", "WEB", "ANDROID", "IOS"]),
  token: z.string().trim().min(20).max(4096),
});

const createOfficeSchema = z.object({
  address: optionalTrimmedString(300),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  maxAccuracyMeters: z.coerce.number().int().min(10).max(1000).default(100),
  name: z.string().trim().min(1, "Office name is required.").max(120),
  radiusMeters: z.coerce.number().int().min(20).max(5000).default(100),
});

const updateOfficeSchema = createOfficeSchema.partial().extend({ isActive: z.boolean().optional() });

const createAttendanceCorrectionSchema = z.object({
  direction: z.enum(["in", "out", "IN", "OUT"]),
  reason: z.string().trim().min(10, "Explain why this correction is needed.").max(2000),
  requestedAt: z.string().trim().min(1).max(40),
  scanId: optionalTrimmedString(80),
});

const reviewAttendanceCorrectionSchema = z.object({
  reviewNote: optionalTrimmedString(1000),
  status: z.enum(["approved", "rejected", "APPROVED", "REJECTED"]),
});

const updateUserPermissionsSchema = z.object({
  permissions: z.array(permissionKeySchema).max(50).default([]),
  useRoleDefaults: z.boolean().default(false),
});

const updateWorkspaceSettingsSchema = z
  .object({
    departments: workspaceDepartmentsSchema.optional(),
    holidays: z
      .array(z.string().refine(isDateOnly, "Holiday dates must be valid and use YYYY-MM-DD."))
      .max(200)
      .optional(),
    name: z.string().trim().min(2, "Workspace name must contain at least 2 characters.").max(160).optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    weekStartsOn: z.coerce.number().int().min(0).max(6).optional(),
    workingDays: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7).optional(),
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
    if (settings.workingDays && new Set(settings.workingDays).size !== settings.workingDays.length) {
      context.addIssue({
        code: "custom",
        message: "Working days cannot contain duplicates.",
        path: ["workingDays"],
      });
    }
    if (settings.holidays && new Set(settings.holidays).size !== settings.holidays.length) {
      context.addIssue({
        code: "custom",
        message: "Holiday dates cannot contain duplicates.",
        path: ["holidays"],
      });
    }
    if (settings.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: settings.timezone }).format();
      } catch {
        context.addIssue({
          code: "custom",
          message: "Choose a valid IANA timezone, such as Asia/Karachi.",
          path: ["timezone"],
        });
      }
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
  approveProjectPlanSchema,
  createAttendanceCorrectionSchema,
  createAttendanceScanSchema,
  createModuleSchema,
  createOrganizationUserSchema,
  createOfficeSchema,
  createProjectSchema,
  createPushSubscriptionSchema,
  createTaskSchema,
  createTaskAttachmentSchema,
  createTaskCommentSchema,
  createTimeLogSchema,
  customFieldInputSchema,
  customRecordSchema,
  generateProjectPlanSchema,
  parseBody,
  reviewAttendanceCorrectionSchema,
  reviewProjectPlanSchema,
  setTaskWatchingSchema,
  syncProfileSchema,
  updateCurrentProfileSchema,
  updateCustomFieldSchema,
  updateModuleSchema,
  updateOrganizationUserSchema,
  updateOfficeSchema,
  updateProjectSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  updateUserRoleSchema,
  updateUserPermissionsSchema,
  updateWorkspaceSettingsSchema,
};
