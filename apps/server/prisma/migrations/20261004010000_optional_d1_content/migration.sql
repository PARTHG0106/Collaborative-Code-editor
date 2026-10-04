-- Additive: existing file/snapshot contents remain inline until explicitly migrated.
ALTER TABLE "file_system_items" ADD COLUMN IF NOT EXISTS "content_key" TEXT;
ALTER TABLE "file_versions" ADD COLUMN IF NOT EXISTS "content_key" TEXT;
