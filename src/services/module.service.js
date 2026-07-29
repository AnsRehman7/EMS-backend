const prisma = require("../db/prisma");
const ApiError = require("../utils/apiError");
const { hasPermission, PERMISSIONS } = require("../utils/permissions");
const { safelyRecordAudit } = require("./audit.service");

const ALL_ROLES = ["super_admin", "admin", "manager", "hr", "accounts", "employee"];
const ADMIN_ROLES = ["super_admin", "admin"];
const FIELD_TYPES = new Set([
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
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const systemField = (key, label, type, options = {}) => ({
  isLocked: false,
  isRequired: false,
  isSystem: true,
  isVisible: true,
  key,
  label,
  sortOrder: 0,
  systemFieldKey: key,
  type,
  ...options,
});

const SYSTEM_MODULES = [
  {
    description: "Tasks, assignments, delivery dates, and work progress.",
    fields: [
      systemField("title", "Task title", "TEXT", { isLocked: true, isRequired: true, sortOrder: 10 }),
      systemField("description", "Description", "LONG_TEXT", { isLocked: true, isRequired: true, sortOrder: 20 }),
      systemField("projectId", "Project", "TEXT", { isLocked: true, isRequired: true, sortOrder: 30 }),
      systemField("assignedToId", "Assigned to", "USER", { isLocked: true, sortOrder: 40 }),
      systemField("status", "Status", "SELECT", { isLocked: true, isRequired: true, sortOrder: 50 }),
      systemField("priority", "Priority", "SELECT", { isLocked: true, isRequired: true, sortOrder: 60 }),
      systemField("category", "Category", "TEXT", { isLocked: true, isRequired: true, sortOrder: 70 }),
      systemField("deadline", "Due date", "DATE", { sortOrder: 80 }),
      systemField("estimatedHours", "Estimated hours", "DECIMAL", { sortOrder: 90 }),
      systemField("successCriteria", "Success criteria", "LONG_TEXT", { sortOrder: 100 }),
    ],
    icon: "check-square",
    key: "tasks",
    pluralName: "Tasks",
    primaryKey: "title",
    singularName: "Task",
  },
  {
    description: "Projects, ownership, schedules, portfolio status, and delivery context.",
    fields: [
      systemField("name", "Project name", "TEXT", { isLocked: true, isRequired: true, sortOrder: 10 }),
      systemField("code", "Project code", "TEXT", { sortOrder: 20 }),
      systemField("description", "Scope and requirements", "LONG_TEXT", { sortOrder: 30 }),
      systemField("objective", "Primary objective", "LONG_TEXT", { sortOrder: 40 }),
      systemField("ownerId", "Project owner", "USER", { isLocked: true, isRequired: true, sortOrder: 50 }),
      systemField("status", "Status", "SELECT", { isLocked: true, isRequired: true, sortOrder: 60 }),
      systemField("priority", "Priority", "SELECT", { isLocked: true, isRequired: true, sortOrder: 70 }),
      systemField("startDate", "Start date", "DATE", { sortOrder: 80 }),
      systemField("dueDate", "Due date", "DATE", { sortOrder: 90 }),
      systemField("department", "Department", "TEXT", { sortOrder: 100 }),
      systemField("clientName", "Client or stakeholder", "TEXT", { sortOrder: 110 }),
      systemField("estimatedHours", "Estimated hours", "DECIMAL", { sortOrder: 120 }),
      systemField("tags", "Tags", "MULTI_SELECT", { sortOrder: 130 }),
    ],
    icon: "briefcase",
    key: "projects",
    pluralName: "Projects",
    primaryKey: "name",
    singularName: "Project",
  },
  {
    description: "Workspace members, account access, roles, and employee profile information.",
    fields: [
      systemField("fullName", "Full name", "TEXT", { isLocked: true, isRequired: true, sortOrder: 10 }),
      systemField("email", "Work email", "EMAIL", { isLocked: true, isRequired: true, sortOrder: 20 }),
      systemField("role", "Role", "SELECT", { isLocked: true, isRequired: true, sortOrder: 30 }),
      systemField("status", "Account status", "SELECT", { isLocked: true, isRequired: true, sortOrder: 40 }),
      systemField("designation", "Designation", "TEXT", { sortOrder: 50 }),
      systemField("department", "Department", "TEXT", { sortOrder: 60 }),
      systemField("contact", "Contact number", "PHONE", { sortOrder: 70 }),
    ],
    icon: "users",
    key: "users",
    pluralName: "Users",
    primaryKey: "fullName",
    singularName: "User",
  },
  {
    description: "Clock events, location evidence, and attendance outcomes.",
    fields: [
      systemField("userId", "Team member", "USER", { isLocked: true, isRequired: true, sortOrder: 10 }),
      systemField("direction", "Clock direction", "SELECT", { isLocked: true, isRequired: true, sortOrder: 20 }),
      systemField("scannedAt", "Recorded at", "DATETIME", { isLocked: true, isRequired: true, sortOrder: 30 }),
      systemField("source", "Source", "TEXT", { sortOrder: 40 }),
      systemField("accuracyMeters", "Location accuracy", "DECIMAL", { sortOrder: 50 }),
    ],
    icon: "clock",
    key: "attendance",
    pluralName: "Attendance",
    primaryKey: "scannedAt",
    singularName: "Attendance entry",
  },
];

const moduleInclude = {
  fields: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  },
};

const actorRole = (currentUser) => String(currentUser?.role || "EMPLOYEE").toLowerCase();
const normalizeRoles = (roles = []) =>
  [...new Set(roles.map((role) => String(role).trim().toLowerCase()))].filter((role) =>
    ALL_ROLES.includes(role),
  );
const normalizeType = (type) => String(type || "TEXT").trim().toUpperCase();
const isMissing = (value) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

const normalizeOptions = (options = []) =>
  (options || []).map((option) => {
    if (typeof option === "string") return { label: option.trim(), value: option.trim() };
    return { label: String(option.label).trim(), value: String(option.value).trim() };
  });

const normalizeFieldInput = (field, index = 0, { allowEmptyOptions = false } = {}) => {
  const type = normalizeType(field.type);
  if (!FIELD_TYPES.has(type)) throw new ApiError(400, "Choose a supported field type.");
  if (RESERVED_KEYS.has(field.key)) throw new ApiError(400, "That field key is reserved.");

  const options = normalizeOptions(field.options);
  if (["SELECT", "MULTI_SELECT"].includes(type) && options.length === 0 && !allowEmptyOptions) {
    throw new ApiError(400, `${field.label} needs at least one option.`);
  }
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new ApiError(400, `${field.label} contains duplicate option values.`);
  }
  if (field.isRequired && field.isVisible === false) {
    throw new ApiError(400, `${field.label} cannot be required while hidden.`);
  }

  return {
    defaultValue: field.defaultValue,
    description: field.description || null,
    isRequired: Boolean(field.isRequired),
    isVisible: field.isVisible !== false,
    key: field.key,
    label: field.label,
    options: options.length ? options : undefined,
    placeholder: field.placeholder || null,
    sortOrder: field.sortOrder ?? (index + 1) * 10,
    type,
    validation: field.validation || undefined,
  };
};

const hasModuleAccess = (module, currentUser, action = "view") => {
  if (actorRole(currentUser) === "super_admin") return true;
  if (module.kind === "SYSTEM") return true;
  return (module[`${action}Roles`] || []).includes(actorRole(currentUser));
};

const assertModuleAccess = (module, currentUser, action = "view") => {
  if (!hasModuleAccess(module, currentUser, action)) {
    throw new ApiError(403, `You do not have permission to ${action} ${module.pluralName.toLowerCase()}.`);
  }
};

const assertCustomizationAdmin = (currentUser) => {
  if (
    actorRole(currentUser) !== "super_admin" ||
    !hasPermission(currentUser, PERMISSIONS.CUSTOMIZATION_MANAGE)
  ) {
    throw new ApiError(403, "Only the workspace super admin can customize modules and fields.");
  }
};

const serializeField = (field) => ({
  archived: Boolean(field.archivedAt),
  createdAt: field.createdAt,
  defaultValue: field.defaultValue ?? null,
  description: field.description || "",
  id: field.id,
  isLocked: field.isLocked,
  isRequired: field.isRequired,
  isSystem: field.isSystem,
  isVisible: field.isVisible,
  key: field.key,
  label: field.label,
  options: field.options || [],
  placeholder: field.placeholder || "",
  sortOrder: field.sortOrder,
  systemFieldKey: field.systemFieldKey || "",
  type: String(field.type).toLowerCase(),
  updatedAt: field.updatedAt,
  validation: field.validation || {},
});

const serializeModule = (module, currentUser) => ({
  access: {
    canCreate: hasModuleAccess(module, currentUser, "create"),
    canCustomize:
      actorRole(currentUser) === "super_admin" &&
      hasPermission(currentUser, PERMISSIONS.CUSTOMIZATION_MANAGE),
    canDelete: hasModuleAccess(module, currentUser, "delete"),
    canEdit: hasModuleAccess(module, currentUser, "edit"),
    canView: hasModuleAccess(module, currentUser, "view"),
  },
  createRoles: module.createRoles || [],
  createdAt: module.createdAt,
  deleteRoles: module.deleteRoles || [],
  description: module.description || "",
  editRoles: module.editRoles || [],
  fields: (module.fields || []).map(serializeField),
  icon: module.icon,
  id: module.id,
  key: module.key,
  kind: String(module.kind).toLowerCase(),
  pluralName: module.pluralName,
  primaryFieldId: module.primaryFieldId || "",
  schemaVersion: module.schemaVersion || 1,
  singularName: module.singularName,
  status: String(module.status).toLowerCase(),
  systemKey: module.systemKey || "",
  updatedAt: module.updatedAt,
  viewRoles: module.viewRoles || [],
});

const ensureSystemModules = async (currentUser) => {
  const organizationId = currentUser.organizationId;

  for (const definition of SYSTEM_MODULES) {
    let module = await prisma.moduleDefinition.findUnique({
      include: moduleInclude,
      where: {
        organizationId_key: {
          key: definition.key,
          organizationId,
        },
      },
    });

    if (!module) {
      try {
        module = await prisma.moduleDefinition.create({
          data: {
            createRoles: ALL_ROLES,
            createdById: currentUser.id,
            deleteRoles: ADMIN_ROLES,
            description: definition.description,
            editRoles: ALL_ROLES,
            fields: {
              create: definition.fields,
            },
            icon: definition.icon,
            key: definition.key,
            kind: "SYSTEM",
            organizationId,
            pluralName: definition.pluralName,
            singularName: definition.singularName,
            systemKey: definition.key,
            updatedById: currentUser.id,
            viewRoles: ALL_ROLES,
          },
          include: moduleInclude,
        });
      } catch (error) {
        if (error.code !== "P2002") throw error;
        module = await prisma.moduleDefinition.findUnique({
          include: moduleInclude,
          where: { organizationId_key: { key: definition.key, organizationId } },
        });
      }
    }

    const existingKeys = new Set(module.fields.map((field) => field.key));
    const missingFields = definition.fields.filter((field) => !existingKeys.has(field.key));
    if (missingFields.length) {
      await prisma.customFieldDefinition.createMany({
        data: missingFields.map((field) => ({ ...field, moduleId: module.id })),
        skipDuplicates: true,
      });
      module = await prisma.moduleDefinition.findUnique({
        include: moduleInclude,
        where: { id: module.id },
      });
    }

    if (!module.primaryFieldId) {
      const primaryField = module.fields.find((field) => field.key === definition.primaryKey);
      if (primaryField) {
        await prisma.moduleDefinition.update({
          data: { primaryFieldId: primaryField.id },
          where: { id: module.id },
        });
      }
    }
  }
};

const getModuleRecord = async (currentUser, where, { includeArchived = false } = {}) => {
  await ensureSystemModules(currentUser);
  const module = await prisma.moduleDefinition.findFirst({
    include: moduleInclude,
    where: {
      organizationId: currentUser.organizationId,
      ...where,
      ...(!includeArchived ? { status: "ACTIVE" } : {}),
    },
  });
  if (!module) throw new ApiError(404, "Module not found.");
  return module;
};

const listAvailableModules = async (currentUser) => {
  await ensureSystemModules(currentUser);
  const modules = await prisma.moduleDefinition.findMany({
    include: moduleInclude,
    orderBy: [{ kind: "asc" }, { pluralName: "asc" }],
    where: {
      organizationId: currentUser.organizationId,
      status: "ACTIVE",
    },
  });
  return modules
    .filter((module) => hasModuleAccess(module, currentUser, "view"))
    .map((module) => serializeModule(module, currentUser));
};

const listCustomizationModules = async (currentUser) => {
  assertCustomizationAdmin(currentUser);
  await ensureSystemModules(currentUser);
  const modules = await prisma.moduleDefinition.findMany({
    include: moduleInclude,
    orderBy: [{ kind: "asc" }, { pluralName: "asc" }],
    where: { organizationId: currentUser.organizationId },
  });
  return modules.map((module) => serializeModule(module, currentUser));
};

const getModuleByKey = async (currentUser, moduleKey) => {
  const module = await getModuleRecord(currentUser, { key: moduleKey });
  assertModuleAccess(module, currentUser, "view");
  return serializeModule(module, currentUser);
};

const createModule = async (currentUser, payload) => {
  assertCustomizationAdmin(currentUser);
  if (SYSTEM_MODULES.some((module) => module.key === payload.key)) {
    throw new ApiError(400, "That module key is reserved by StaffFlow.");
  }

  const fields = payload.fields.map(normalizeFieldInput);
  if (new Set(fields.map((field) => field.key)).size !== fields.length) {
    throw new ApiError(400, "Field keys must be unique inside a module.");
  }

  let module;
  try {
    module = await prisma.$transaction(async (transaction) => {
      const createdModule = await transaction.moduleDefinition.create({
        data: {
          createRoles: normalizeRoles(payload.createRoles),
          createdById: currentUser.id,
          deleteRoles: normalizeRoles(payload.deleteRoles),
          description: payload.description || null,
          editRoles: normalizeRoles(payload.editRoles),
          icon: payload.icon || "database",
          key: payload.key,
          kind: "CUSTOM",
          organizationId: currentUser.organizationId,
          pluralName: payload.pluralName,
          singularName: payload.singularName,
          updatedById: currentUser.id,
          viewRoles: normalizeRoles(payload.viewRoles),
        },
      });
      await transaction.customFieldDefinition.createMany({
        data: fields.map((field) => ({ ...field, moduleId: createdModule.id })),
      });
      const primaryField = await transaction.customFieldDefinition.findFirst({
        orderBy: { sortOrder: "asc" },
        where: { moduleId: createdModule.id },
      });
      return transaction.moduleDefinition.update({
        data: { primaryFieldId: primaryField.id },
        include: moduleInclude,
        where: { id: createdModule.id },
      });
    });
  } catch (error) {
    if (error.code === "P2002") throw new ApiError(409, "A module or field already uses that key.");
    throw error;
  }

  await safelyRecordAudit({
    action: "CREATED",
    actor: currentUser,
    entityId: module.id,
    entityType: "MODULE",
    metadata: { fieldCount: module.fields.length, key: module.key },
    summary: `Created module: ${module.pluralName}`,
  });
  return serializeModule(module, currentUser);
};

const getModuleForCustomization = async (currentUser, moduleId) => {
  assertCustomizationAdmin(currentUser);
  return getModuleRecord(currentUser, { id: moduleId }, { includeArchived: true });
};

const updateModule = async (currentUser, moduleId, payload) => {
  const existing = await getModuleForCustomization(currentUser, moduleId);
  if (existing.kind === "SYSTEM" && String(payload.status || "").toUpperCase() === "ARCHIVED") {
    throw new ApiError(400, "Core StaffFlow modules cannot be archived.");
  }
  if (payload.primaryFieldId) {
    const primaryField = existing.fields.find(
      (field) => field.id === payload.primaryFieldId && !field.archivedAt && field.isVisible,
    );
    if (!primaryField) throw new ApiError(400, "Choose a visible field from this module as its primary field.");
  }

  const data = {
    schemaVersion: { increment: 1 },
    updatedById: currentUser.id,
  };
  ["description", "icon", "pluralName", "primaryFieldId", "singularName"].forEach((key) => {
    if (payload[key] !== undefined) data[key] = payload[key] || null;
  });
  ["createRoles", "deleteRoles", "editRoles", "viewRoles"].forEach((key) => {
    if (payload[key] !== undefined) data[key] = normalizeRoles(payload[key]);
  });
  if (payload.status !== undefined) data.status = String(payload.status).toUpperCase();

  const module = await prisma.moduleDefinition.update({
    data,
    include: moduleInclude,
    where: { id: existing.id },
  });
  await safelyRecordAudit({
    action: module.status === "ARCHIVED" ? "ARCHIVED" : "UPDATED",
    actor: currentUser,
    entityId: module.id,
    entityType: "MODULE",
    metadata: { fields: Object.keys(payload) },
    summary: `Updated module: ${module.pluralName}`,
  });
  return serializeModule(module, currentUser);
};

const createField = async (currentUser, moduleId, payload) => {
  const module = await getModuleForCustomization(currentUser, moduleId);
  if (module.fields.length >= 100) throw new ApiError(400, "A module can contain up to 100 fields.");
  const fieldData = normalizeFieldInput(payload, module.fields.length);

  let field;
  try {
    field = await prisma.customFieldDefinition.create({
      data: { ...fieldData, moduleId: module.id },
    });
  } catch (error) {
    if (error.code === "P2002") throw new ApiError(409, "A field already uses that key in this module.");
    throw error;
  }

  await prisma.moduleDefinition.update({
    data: { schemaVersion: { increment: 1 }, updatedById: currentUser.id },
    where: { id: module.id },
  });
  await safelyRecordAudit({
    action: "FIELD_CREATED",
    actor: currentUser,
    entityId: module.id,
    entityType: "MODULE",
    metadata: { fieldId: field.id, fieldKey: field.key, fieldType: field.type },
    summary: `Added ${field.label} to ${module.pluralName}`,
  });
  return serializeField(field);
};

const getStoredDataRows = (module) =>
    module.kind === "CUSTOM"
      ? prisma.customModuleRecord.findMany({
          select: { data: true },
          where: { moduleId: module.id },
        })
      : prisma.customEntityData.findMany({
          select: { data: true },
          where: { moduleId: module.id },
        });

const fieldHasStoredValue = async (module, fieldKey) => {
  const source = await getStoredDataRows(module);
  return source.some(({ data }) => !isMissing(data?.[fieldKey]));
};

const assertCanRequireField = async (module, field) => {
  if (field.isSystem) {
    const modelName = {
      attendance: "attendanceScan",
      projects: "project",
      tasks: "task",
      users: "user",
    }[module.systemKey];
    if (!modelName) return;
    const records = await prisma[modelName].findMany({
      select: { [field.systemFieldKey || field.key]: true },
      where: { organizationId: module.organizationId },
    });
    if (records.some((record) => isMissing(record[field.systemFieldKey || field.key]))) {
      throw new ApiError(409, "Fill this field on existing records before making it mandatory.");
    }
    return;
  }
  const source = await getStoredDataRows(module);
  if (source.some(({ data }) => isMissing(data?.[field.key]))) {
    throw new ApiError(409, "Fill this field on existing records before making it mandatory.");
  }
};

const updateField = async (currentUser, moduleId, fieldId, payload) => {
  const module = await getModuleForCustomization(currentUser, moduleId);
  const existing = module.fields.find((field) => field.id === fieldId);
  if (!existing) throw new ApiError(404, "Field not found.");
  if (payload.key !== undefined && payload.key !== existing.key) {
    throw new ApiError(400, "Field keys cannot change after creation because they identify stored values.");
  }
  if (existing.isSystem && payload.type && normalizeType(payload.type) !== existing.type) {
    throw new ApiError(400, "Core field types cannot be changed.");
  }
  if (
    existing.isLocked &&
    (payload.archived === true ||
      payload.isVisible === false ||
      (payload.isRequired !== undefined && payload.isRequired !== existing.isRequired))
  ) {
    throw new ApiError(400, "This core field is structural and its availability rules cannot be changed.");
  }
  if (payload.archived === true && module.primaryFieldId === existing.id) {
    throw new ApiError(400, "Choose another primary field before removing this field.");
  }
  if (
    (payload.isRequired === true && !existing.isRequired) ||
    (payload.archived === false && existing.isRequired)
  ) {
    await assertCanRequireField(module, existing);
  }
  if (payload.type && normalizeType(payload.type) !== existing.type && (await fieldHasStoredValue(module, existing.key))) {
    throw new ApiError(409, "This field already contains data. Create a new field instead of changing its type.");
  }
  if (
    payload.options &&
    ["SELECT", "MULTI_SELECT"].includes(existing.type) &&
    !existing.isSystem
  ) {
    const allowed = new Set(normalizeOptions(payload.options).map((option) => option.value));
    const source = await getStoredDataRows(module);
    const unsupportedValue = source.some(({ data }) => {
      const currentValue = data?.[existing.key];
      const selected = Array.isArray(currentValue) ? currentValue : [currentValue];
      return selected.filter((value) => !isMissing(value)).some((value) => !allowed.has(value));
    });
    if (unsupportedValue) {
      throw new ApiError(409, "An existing record uses an option you are trying to remove.");
    }
  }

  const merged = normalizeFieldInput(
    {
      ...serializeField(existing),
      ...payload,
      key: existing.key,
      type: payload.type || existing.type,
    },
    existing.sortOrder / 10,
    { allowEmptyOptions: existing.isSystem },
  );
  const field = await prisma.customFieldDefinition.update({
    data: {
      ...merged,
      archivedAt: payload.archived === true ? new Date() : payload.archived === false ? null : existing.archivedAt,
      isLocked: existing.isLocked,
      isSystem: existing.isSystem,
      systemFieldKey: existing.systemFieldKey,
    },
    where: { id: existing.id },
  });
  await prisma.moduleDefinition.update({
    data: { schemaVersion: { increment: 1 }, updatedById: currentUser.id },
    where: { id: module.id },
  });
  await safelyRecordAudit({
    action: field.archivedAt ? "FIELD_ARCHIVED" : "FIELD_UPDATED",
    actor: currentUser,
    entityId: module.id,
    entityType: "MODULE",
    metadata: { fieldId: field.id, fieldKey: field.key, fields: Object.keys(payload) },
    summary: `${field.archivedAt ? "Removed" : "Updated"} ${field.label} in ${module.pluralName}`,
  });
  return serializeField(field);
};

const archiveField = (currentUser, moduleId, fieldId) =>
  updateField(currentUser, moduleId, fieldId, { archived: true });

const parseFieldValue = async (field, rawValue, currentUser) => {
  if (isMissing(rawValue)) return null;
  const validation = field.validation || {};
  let value;

  switch (field.type) {
    case "INTEGER":
      value = Number(rawValue);
      if (!Number.isInteger(value)) throw new ApiError(400, `${field.label} must be a whole number.`);
      break;
    case "DECIMAL":
      value = Number(rawValue);
      if (!Number.isFinite(value)) throw new ApiError(400, `${field.label} must be a number.`);
      break;
    case "BOOLEAN":
      if (typeof rawValue === "boolean") value = rawValue;
      else if (rawValue === "true" || rawValue === "1") value = true;
      else if (rawValue === "false" || rawValue === "0") value = false;
      else throw new ApiError(400, `${field.label} must be yes or no.`);
      break;
    case "DATE": {
      const dateText = String(rawValue);
      const parsed = new Date(`${dateText}T00:00:00.000Z`);
      if (
        Number.isNaN(parsed.getTime()) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dateText) ||
        parsed.toISOString().slice(0, 10) !== dateText
      ) {
        throw new ApiError(400, `${field.label} must be a valid date.`);
      }
      value = dateText;
      break;
    }
    case "DATETIME": {
      const parsed = new Date(rawValue);
      if (Number.isNaN(parsed.getTime())) throw new ApiError(400, `${field.label} must be a valid date and time.`);
      value = parsed.toISOString();
      break;
    }
    case "MULTI_SELECT":
      if (!Array.isArray(rawValue)) throw new ApiError(400, `${field.label} must contain a list of options.`);
      value = [...new Set(rawValue.map((item) => String(item).trim()).filter(Boolean))];
      break;
    case "USER": {
      value = String(rawValue).trim();
      const user = await prisma.user.findFirst({
        select: { id: true },
        where: { id: value, organizationId: currentUser.organizationId, status: "ACTIVE" },
      });
      if (!user) throw new ApiError(400, `${field.label} must reference an active workspace member.`);
      break;
    }
    default:
      value = String(rawValue).trim();
  }

  if (typeof value === "number") {
    if (validation.min !== undefined && value < validation.min) {
      throw new ApiError(400, `${field.label} must be at least ${validation.min}.`);
    }
    if (validation.max !== undefined && value > validation.max) {
      throw new ApiError(400, `${field.label} must be at most ${validation.max}.`);
    }
  }
  if (typeof value === "string") {
    const defaultMax = field.type === "LONG_TEXT" ? 100000 : 5000;
    if (value.length < (validation.minLength || 0)) {
      throw new ApiError(400, `${field.label} is shorter than the allowed minimum.`);
    }
    if (value.length > (validation.maxLength || defaultMax)) {
      throw new ApiError(400, `${field.label} is longer than the allowed maximum.`);
    }
    if (field.type === "EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new ApiError(400, `${field.label} must be a valid email address.`);
    }
    if (field.type === "URL") {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new ApiError(400, `${field.label} must be a valid URL.`);
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new ApiError(400, `${field.label} must use http or https.`);
      }
    }
  }
  if (["SELECT", "MULTI_SELECT"].includes(field.type)) {
    const allowed = new Set((field.options || []).map((option) => option.value));
    const selected = Array.isArray(value) ? value : [value];
    if (selected.some((item) => !allowed.has(item))) {
      throw new ApiError(400, `${field.label} contains an unsupported option.`);
    }
  }
  return value;
};

const validateValues = async (module, values, currentUser, existing = {}, { systemOnlyCustom = false } = {}) => {
  const fields = module.fields.filter(
    (field) =>
      !field.archivedAt &&
      field.isVisible &&
      (!systemOnlyCustom || !field.isSystem),
  );
  const allowedKeys = new Set(fields.map((field) => field.key));
  const invalidKey = Object.keys(values || {}).find((key) => !allowedKeys.has(key));
  if (invalidKey) throw new ApiError(400, `Field "${invalidKey}" is not active in this module.`);

  const nextValues = { ...(existing || {}) };
  for (const field of fields) {
    const supplied = Object.prototype.hasOwnProperty.call(values || {}, field.key);
    const rawValue = supplied
      ? values[field.key]
      : Object.prototype.hasOwnProperty.call(nextValues, field.key)
        ? nextValues[field.key]
        : field.defaultValue;
    if (field.isRequired && isMissing(rawValue)) {
      throw new ApiError(400, `${field.label} is required.`);
    }
    if (supplied || (!Object.prototype.hasOwnProperty.call(nextValues, field.key) && field.defaultValue !== null)) {
      nextValues[field.key] = await parseFieldValue(field, rawValue, currentUser);
    }
  }
  return nextValues;
};

const recordChangeSet = (before = {}, after = {}, fields = []) =>
  fields.flatMap((field) =>
    JSON.stringify(before[field.key] ?? null) === JSON.stringify(after[field.key] ?? null)
      ? []
      : [{ field: field.key, from: before[field.key] ?? null, label: field.label, to: after[field.key] ?? null }],
  );

const serializeRecord = (record, module) => {
  const primaryField = module.fields.find((field) => field.id === module.primaryFieldId);
  const fallbackField = module.fields.find((field) => !field.archivedAt && field.isVisible);
  const displayValue = record.data?.[primaryField?.key] ?? record.data?.[fallbackField?.key];
  return {
    createdAt: record.createdAt,
    createdBy: record.createdBy
      ? { id: record.createdBy.id, name: record.createdBy.fullName }
      : null,
    displayName: isMissing(displayValue) ? `${module.singularName} record` : String(displayValue),
    id: record.id,
    schemaVersion: record.schemaVersion || 1,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy
      ? { id: record.updatedBy.id, name: record.updatedBy.fullName }
      : null,
    values: record.data || {},
  };
};

const customRecordInclude = {
  createdBy: { select: { fullName: true, id: true } },
  updatedBy: { select: { fullName: true, id: true } },
};

const getCustomModule = async (currentUser, moduleKey, action = "view") => {
  const module = await getModuleRecord(currentUser, { key: moduleKey });
  if (module.kind !== "CUSTOM") throw new ApiError(400, "Core modules use their dedicated workspace pages.");
  assertModuleAccess(module, currentUser, action);
  return module;
};

const listRecords = async (currentUser, moduleKey, filters = {}) => {
  const module = await getCustomModule(currentUser, moduleKey, "view");
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 100));
  const skip = (page - 1) * limit;
  const search = String(filters.search || "").trim();
  let recordIds = null;
  let total;
  if (search) {
    const pattern = `%${search}%`;
    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT id FROM "custom_module_records"
        WHERE "moduleId" = ${module.id}
          AND "organizationId" = ${currentUser.organizationId}
          AND CAST(data AS TEXT) ILIKE ${pattern}
        ORDER BY "updatedAt" DESC
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count FROM "custom_module_records"
        WHERE "moduleId" = ${module.id}
          AND "organizationId" = ${currentUser.organizationId}
          AND CAST(data AS TEXT) ILIKE ${pattern}
      `,
    ]);
    recordIds = rows.map((row) => row.id);
    total = Number(countRows[0]?.count || 0);
  } else {
    total = await prisma.customModuleRecord.count({
      where: { moduleId: module.id, organizationId: currentUser.organizationId },
    });
  }
  const records = await prisma.customModuleRecord.findMany({
    include: customRecordInclude,
    orderBy: { updatedAt: "desc" },
    ...(recordIds ? {} : { skip, take: limit }),
    where: {
      moduleId: module.id,
      organizationId: currentUser.organizationId,
      ...(recordIds ? { id: { in: recordIds } } : {}),
    },
  });
  return {
    module: serializeModule(module, currentUser),
    pagination: { limit, page, pages: Math.max(1, Math.ceil(total / limit)), total },
    records: records.map((record) => serializeRecord(record, module)),
  };
};

const getRecord = async (currentUser, moduleKey, recordId) => {
  const module = await getCustomModule(currentUser, moduleKey, "view");
  const record = await prisma.customModuleRecord.findFirst({
    include: customRecordInclude,
    where: { id: recordId, moduleId: module.id, organizationId: currentUser.organizationId },
  });
  if (!record) throw new ApiError(404, `${module.singularName} record not found.`);
  return { module: serializeModule(module, currentUser), record: serializeRecord(record, module) };
};

const createRecord = async (currentUser, moduleKey, values) => {
  const module = await getCustomModule(currentUser, moduleKey, "create");
  const data = await validateValues(module, values, currentUser);
  const record = await prisma.customModuleRecord.create({
    data: {
      createdById: currentUser.id,
      data,
      moduleId: module.id,
      organizationId: currentUser.organizationId,
      schemaVersion: module.schemaVersion || 1,
      updatedById: currentUser.id,
    },
    include: customRecordInclude,
  });
  await safelyRecordAudit({
    action: "CREATED",
    actor: currentUser,
    entityId: record.id,
    entityType: `CUSTOM_${module.key}`,
    metadata: { moduleId: module.id },
    summary: `Created ${module.singularName}: ${serializeRecord(record, module).displayName}`,
  });
  return serializeRecord(record, module);
};

const updateRecord = async (currentUser, moduleKey, recordId, values) => {
  const module = await getCustomModule(currentUser, moduleKey, "edit");
  const existing = await prisma.customModuleRecord.findFirst({
    where: { id: recordId, moduleId: module.id, organizationId: currentUser.organizationId },
  });
  if (!existing) throw new ApiError(404, `${module.singularName} record not found.`);
  const data = await validateValues(module, values, currentUser, existing.data || {});
  const record = await prisma.customModuleRecord.update({
    data: { data, schemaVersion: module.schemaVersion || 1, updatedById: currentUser.id },
    include: customRecordInclude,
    where: { id: existing.id },
  });
  const changes = recordChangeSet(existing.data, data, module.fields);
  if (changes.length) {
    await safelyRecordAudit({
      action: "UPDATED",
      actor: currentUser,
      entityId: record.id,
      entityType: `CUSTOM_${module.key}`,
      metadata: { changes, moduleId: module.id },
      summary: `Updated ${module.singularName}: ${serializeRecord(record, module).displayName}`,
    });
  }
  return serializeRecord(record, module);
};

const deleteRecord = async (currentUser, moduleKey, recordId) => {
  const module = await getCustomModule(currentUser, moduleKey, "delete");
  const existing = await prisma.customModuleRecord.findFirst({
    where: { id: recordId, moduleId: module.id, organizationId: currentUser.organizationId },
  });
  if (!existing) throw new ApiError(404, `${module.singularName} record not found.`);
  await prisma.customModuleRecord.delete({ where: { id: existing.id } });
  await safelyRecordAudit({
    action: "DELETED",
    actor: currentUser,
    entityId: existing.id,
    entityType: `CUSTOM_${module.key}`,
    metadata: { moduleId: module.id },
    summary: `Deleted ${module.singularName} record`,
  });
};

const getSystemModule = (currentUser, systemKey) =>
  getModuleRecord(currentUser, { kind: "SYSTEM", systemKey });

const validateSystemCustomValues = async ({
  currentUser,
  existingValues = {},
  systemKey,
  values = {},
}) => {
  const module = await getSystemModule(currentUser, systemKey);
  return validateValues(module, values, currentUser, existingValues, { systemOnlyCustom: true });
};

const validateSystemFields = async ({ currentUser, systemKey, values }) => {
  const module = await getSystemModule(currentUser, systemKey);
  const missingField = module.fields.find(
    (field) =>
      field.isSystem &&
      !field.archivedAt &&
      field.isVisible &&
      field.isRequired &&
      isMissing(values?.[field.systemFieldKey || field.key]),
  );
  if (missingField) throw new ApiError(400, `${missingField.label} is required.`);
};

const saveSystemEntityData = async ({
  currentUser,
  entityId,
  existingValues,
  preparedData,
  systemKey,
  values = {},
}) => {
  const module = await getSystemModule(currentUser, systemKey);
  const customFields = module.fields.filter((field) => !field.isSystem && !field.archivedAt && field.isVisible);
  if (!customFields.length && Object.keys(values || {}).length === 0) return existingValues || {};
  const existing = await prisma.customEntityData.findUnique({
    where: { moduleId_entityId: { entityId, moduleId: module.id } },
  });
  const data =
    preparedData ||
    (await validateValues(
      module,
      values,
      currentUser,
      existingValues ?? existing?.data ?? {},
      { systemOnlyCustom: true },
    ));
  const row = await prisma.customEntityData.upsert({
    create: {
      createdById: currentUser.id,
    data,
      entityId,
      moduleId: module.id,
      organizationId: currentUser.organizationId,
      schemaVersion: module.schemaVersion || 1,
      updatedById: currentUser.id,
    },
    update: { data, schemaVersion: module.schemaVersion || 1, updatedById: currentUser.id },
    where: { moduleId_entityId: { entityId, moduleId: module.id } },
  });
  const changes = recordChangeSet(existing?.data || {}, row.data || {}, customFields);
  if (changes.length) {
    await safelyRecordAudit({
      action: "CUSTOM_FIELDS_UPDATED",
      actor: currentUser,
      entityId,
      entityType: systemKey.slice(0, -1).toUpperCase(),
      metadata: { changes, moduleId: module.id },
      summary: `Updated custom fields on ${module.singularName.toLowerCase()}`,
    });
  }
  return row.data || {};
};

const attachSystemCustomData = async (currentUser, systemKey, entities) => {
  if (!entities.length) return entities;
  const module = await getSystemModule(currentUser, systemKey);
  const rows = await prisma.customEntityData.findMany({
    select: { data: true, entityId: true },
    where: { entityId: { in: entities.map((entity) => entity.id) }, moduleId: module.id },
  });
  const byEntity = new Map(rows.map((row) => [row.entityId, row.data || {}]));
  return entities.map((entity) => ({ ...entity, customFields: byEntity.get(entity.id) || {} }));
};

const getSystemEntityData = async (currentUser, systemKey, entityId) => {
  const module = await getSystemModule(currentUser, systemKey);
  const row = await prisma.customEntityData.findUnique({
    where: { moduleId_entityId: { entityId, moduleId: module.id } },
  });
  return row?.data || {};
};

const deleteSystemEntityData = async (currentUser, systemKey, entityId) => {
  const module = await getSystemModule(currentUser, systemKey);
  await prisma.customEntityData.deleteMany({
    where: { entityId, moduleId: module.id, organizationId: currentUser.organizationId },
  });
};

module.exports = {
  archiveField,
  attachSystemCustomData,
  createField,
  createModule,
  createRecord,
  deleteSystemEntityData,
  deleteRecord,
  getModuleByKey,
  getRecord,
  getSystemEntityData,
  listAvailableModules,
  listCustomizationModules,
  listRecords,
  saveSystemEntityData,
  updateField,
  updateModule,
  updateRecord,
  validateSystemCustomValues,
  validateSystemFields,
};
