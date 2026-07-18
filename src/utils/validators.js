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
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  email: z.string().trim().email("Enter a valid email address.").max(255),
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
  password: z.string().min(6, "Password must be at least 6 characters.").max(128),
  role: z.enum(roleValues).default("employee"),
});

const updateOrganizationUserSchema = z.object({
  contact: optionalTrimmedString(40),
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
  department: optionalTrimmedString(120),
  designation: optionalTrimmedString(120),
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
});

const updateUserPermissionsSchema = z.object({
  permissions: z.array(permissionKeySchema).max(50).default([]),
  useRoleDefaults: z.boolean().default(false),
});

const parseBody = (schema, body) => schema.parse(body || {});

module.exports = {
  createAttendanceScanSchema,
  createOrganizationUserSchema,
  createProjectSchema,
  createTaskSchema,
  createTimeLogSchema,
  parseBody,
  syncProfileSchema,
  updateCurrentProfileSchema,
  updateOrganizationUserSchema,
  updateProjectSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  updateUserRoleSchema,
  updateUserPermissionsSchema,
};
