-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MEMBER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'MEMBER';

-- CreateIndex
CREATE INDEX "Transaction_transactionDate_createdAt_id_idx" ON "Transaction"("transactionDate", "createdAt", "id");
