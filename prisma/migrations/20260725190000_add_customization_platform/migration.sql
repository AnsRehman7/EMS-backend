-- CreateEnum
CREATE TYPE "ModuleKind" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ModuleStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM (
    'TEXT',
    'LONG_TEXT',
    'INTEGER',
    'DECIMAL',
    'BOOLEAN',
    'DATE',
    'DATETIME',
    'EMAIL',
    'PHONE',
    'URL',
    'SELECT',
    'MULTI_SELECT',
    'USER'
);

-- CreateTable
CREATE TABLE "module_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "singularName" TEXT NOT NULL,
    "pluralName" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'database',
    "kind" "ModuleKind" NOT NULL,
    "systemKey" TEXT,
    "status" "ModuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "primaryFieldId" TEXT,
    "viewRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "editRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "deleteRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "module_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "placeholder" TEXT,
    "type" "CustomFieldType" NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "systemFieldKey" TEXT,
    "options" JSONB,
    "defaultValue" JSONB,
    "validation" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_module_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_module_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_entity_data" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_entity_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "module_definitions_organizationId_key_key" ON "module_definitions"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "module_definitions_organizationId_systemKey_key" ON "module_definitions"("organizationId", "systemKey");

-- CreateIndex
CREATE INDEX "module_definitions_organizationId_status_idx" ON "module_definitions"("organizationId", "status");

-- CreateIndex
CREATE INDEX "module_definitions_organizationId_kind_idx" ON "module_definitions"("organizationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_moduleId_key_key" ON "custom_field_definitions"("moduleId", "key");

-- CreateIndex
CREATE INDEX "custom_field_definitions_moduleId_sortOrder_idx" ON "custom_field_definitions"("moduleId", "sortOrder");

-- CreateIndex
CREATE INDEX "custom_field_definitions_moduleId_archivedAt_idx" ON "custom_field_definitions"("moduleId", "archivedAt");

-- CreateIndex
CREATE INDEX "custom_module_records_organizationId_moduleId_updatedAt_idx" ON "custom_module_records"("organizationId", "moduleId", "updatedAt");

-- CreateIndex
CREATE INDEX "custom_module_records_createdById_idx" ON "custom_module_records"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "custom_entity_data_moduleId_entityId_key" ON "custom_entity_data"("moduleId", "entityId");

-- CreateIndex
CREATE INDEX "custom_entity_data_organizationId_moduleId_idx" ON "custom_entity_data"("organizationId", "moduleId");

-- CreateIndex
CREATE INDEX "custom_entity_data_entityId_idx" ON "custom_entity_data"("entityId");

-- AddForeignKey
ALTER TABLE "module_definitions" ADD CONSTRAINT "module_definitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_definitions" ADD CONSTRAINT "module_definitions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_definitions" ADD CONSTRAINT "module_definitions_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "module_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_module_records" ADD CONSTRAINT "custom_module_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_module_records" ADD CONSTRAINT "custom_module_records_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "module_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_module_records" ADD CONSTRAINT "custom_module_records_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_module_records" ADD CONSTRAINT "custom_module_records_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_entity_data" ADD CONSTRAINT "custom_entity_data_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_entity_data" ADD CONSTRAINT "custom_entity_data_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "module_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_entity_data" ADD CONSTRAINT "custom_entity_data_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_entity_data" ADD CONSTRAINT "custom_entity_data_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
