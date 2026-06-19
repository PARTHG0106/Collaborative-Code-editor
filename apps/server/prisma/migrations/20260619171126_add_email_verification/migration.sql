-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verification_expires" TIMESTAMP(3),
ADD COLUMN     "verification_token" TEXT;
