/*
  Warnings:

  - You are about to drop the column `created_at` on the `workspace_members` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `workspace_members` table. All the data in the column will be lost.
  - You are about to drop the `workspace_invitations` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_invited_by_id_fkey";

-- DropForeignKey
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_workspace_id_fkey";

-- AlterTable
ALTER TABLE "workspace_members" DROP COLUMN "created_at",
DROP COLUMN "updated_at",
ADD COLUMN     "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- DropTable
DROP TABLE "workspace_invitations";
