-- CreateEnum
CREATE TYPE "TeamMemberRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "TeamMembershipStatus" AS ENUM ('PENDING', 'APPROVED');

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(240),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TeamMemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "TeamMembershipStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "teamId" TEXT;

-- Backfill the original shared ledger into a migrated team so existing
-- transactions and signed-in users continue to work after team scoping.
WITH inserted_team AS (
    INSERT INTO "Team" ("id", "name", "description", "createdById", "createdAt", "updatedAt")
    SELECT
        CONCAT('c', SUBSTRING(MD5(RANDOM()::text || CLOCK_TIMESTAMP()::text), 1, 24)),
        'Migrated Team',
        'Auto-created from the original shared ledger during the team migration.',
        creator."id",
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    FROM (
        SELECT "id"
        FROM "User"
        ORDER BY "id"
        LIMIT 1
    ) AS creator
    WHERE EXISTS (SELECT 1 FROM "User")
    RETURNING "id"
)
UPDATE "Transaction"
SET "teamId" = inserted_team."id"
FROM inserted_team
WHERE "Transaction"."teamId" IS NULL;

INSERT INTO "TeamMembership" (
    "id",
    "teamId",
    "userId",
    "role",
    "status",
    "approvedAt",
    "approvedById",
    "createdAt",
    "updatedAt"
)
SELECT
    CONCAT('c', SUBSTRING(MD5("User"."id" || migrated_team."id" || CLOCK_TIMESTAMP()::text), 1, 24)),
    migrated_team."id",
    "User"."id",
    CASE
        WHEN "User"."role" = 'ADMIN' THEN 'ADMIN'::"TeamMemberRole"
        ELSE 'MEMBER'::"TeamMemberRole"
    END,
    'APPROVED'::"TeamMembershipStatus",
    CURRENT_TIMESTAMP,
    migrated_team."createdById",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "User"
CROSS JOIN (
    SELECT "id", "createdById"
    FROM "Team"
    WHERE "name" = 'Migrated Team'
    LIMIT 1
) AS migrated_team
WHERE NOT EXISTS (
    SELECT 1
    FROM "TeamMembership"
    WHERE "TeamMembership"."teamId" = migrated_team."id"
      AND "TeamMembership"."userId" = "User"."id"
);

ALTER TABLE "Transaction"
ALTER COLUMN "teamId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");

-- CreateIndex
CREATE INDEX "Team_createdById_idx" ON "Team"("createdById");

-- CreateIndex
CREATE INDEX "TeamMembership_userId_status_idx" ON "TeamMembership"("userId", "status");

-- CreateIndex
CREATE INDEX "TeamMembership_teamId_status_role_idx" ON "TeamMembership"("teamId", "status", "role");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMembership_teamId_userId_key" ON "TeamMembership"("teamId", "userId");

-- CreateIndex
CREATE INDEX "Transaction_teamId_transactionDate_createdAt_idx" ON "Transaction"("teamId", "transactionDate", "createdAt");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
