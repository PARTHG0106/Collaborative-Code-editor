-- CreateEnum
CREATE TYPE "FileSystemItemType" AS ENUM ('FILE', 'FOLDER');

-- CreateTable
CREATE TABLE "file_system_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FileSystemItemType" NOT NULL,
    "content" TEXT,
    "parent_id" TEXT,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_system_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_system_items_workspace_id_parent_id_name_key" ON "file_system_items"("workspace_id", "parent_id", "name");

-- AddForeignKey
ALTER TABLE "file_system_items" ADD CONSTRAINT "file_system_items_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "file_system_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_system_items" ADD CONSTRAINT "file_system_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
