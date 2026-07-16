-- Financial-integrity migration: preserve ledger attribution, add write
-- idempotency, prevent creator deletion from deleting a team, and align the
-- database's positive-amount rule with application validation.
--
-- DEPLOYMENT ORDER
-- 1. Take and verify a restorable database backup.
-- 2. Stop transaction writers (or deploy this migration and the compatible
--    application in one maintenance window). The previous application does not
--    populate the new required snapshot and idempotency columns.
-- 3. Run `prisma migrate deploy` from the release artifact.
-- 4. Deploy the application that always writes idempotencyKey,
--    actorIdSnapshot, and actorNameSnapshot.
-- 5. Verify transaction/team counts and per-team balances without printing
--    user or transaction data, then re-enable writes.
--
-- This migration never deletes or rewrites a financial amount. Legacy
-- transaction keys are deterministic (`legacy:<transaction id>`), and actor
-- attribution is copied before the live user foreign key can become nullable.
-- Any unexpected legacy state aborts the transaction instead of silently
-- dropping or coercing rows.
--
-- ROLLBACK / RECOVERY
-- Prefer forward recovery. After a user has been hard-deleted, the nullable
-- Transaction.userId value cannot be reconstructed from the database user
-- table, so restoring the old NOT NULL/CASCADE relation is not lossless.
-- Before any such deletion, a code rollback can keep these additive columns and
-- safer foreign keys in place. Only remove them after proving every userId is
-- non-null and accepting that doing so removes idempotency and immutable
-- attribution. Never restore ON DELETE CASCADE for a ledger actor or team owner
-- as an emergency rollback.

BEGIN;

-- Soft lifecycle markers are deliberately nullable so existing users remain
-- active and visible without a data rewrite.
ALTER TABLE "User"
ADD COLUMN "disabledAt" TIMESTAMP(3),
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Add as nullable first so existing rows can be backfilled and verified before
-- NOT NULL is enforced. VARCHAR(64) accepts UUID operation keys and the current
-- CUID-based `legacy:<id>` value while keeping the replay-key surface bounded.
ALTER TABLE "Transaction"
ADD COLUMN "idempotencyKey" VARCHAR(64),
ADD COLUMN "actorIdSnapshot" TEXT,
ADD COLUMN "actorNameSnapshot" TEXT;

-- Abort rather than truncate an unusual legacy primary key. No value is logged.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Transaction"
        WHERE CHAR_LENGTH('legacy:' || "id") > 64
    ) THEN
        RAISE EXCEPTION 'Cannot backfill bounded transaction idempotency keys; a legacy transaction identifier is too long.';
    END IF;
END
$$;

-- PostgreSQL INTEGER already enforces the upper int4 bound. Explicitly reject
-- legacy zero/negative rows before installing the positive-value constraint.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Transaction"
        WHERE "amountInCents" <= 0
    ) THEN
        RAISE EXCEPTION 'Cannot add the positive transaction amount constraint while invalid legacy rows exist.';
    END IF;
END
$$;

UPDATE "Transaction" AS ledger_entry
SET
    "idempotencyKey" = 'legacy:' || ledger_entry."id",
    "actorIdSnapshot" = ledger_entry."userId",
    "actorNameSnapshot" = COALESCE(
        NULLIF(BTRIM(actor."name"), ''),
        'Former team member'
    )
FROM "User" AS actor
WHERE actor."id" = ledger_entry."userId";

-- The original foreign key guarantees an actor for every pre-migration row.
-- Keep an explicit assertion so schema drift or a manually damaged database
-- fails closed before constraints are changed.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Transaction"
        WHERE "idempotencyKey" IS NULL
           OR "actorIdSnapshot" IS NULL
           OR "actorNameSnapshot" IS NULL
    ) THEN
        RAISE EXCEPTION 'Cannot preserve ledger attribution because a legacy transaction could not be backfilled.';
    END IF;
END
$$;

ALTER TABLE "Transaction"
DROP CONSTRAINT "Transaction_userId_fkey";

ALTER TABLE "Transaction"
ALTER COLUMN "userId" DROP NOT NULL,
ALTER COLUMN "idempotencyKey" SET NOT NULL,
ALTER COLUMN "actorIdSnapshot" SET NOT NULL,
ALTER COLUMN "actorNameSnapshot" SET NOT NULL;

ALTER TABLE "Transaction"
ADD CONSTRAINT "Transaction_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- A user who owns a team cannot be hard-deleted until ownership is explicitly
-- transferred. This prevents the previous cascading team/ledger deletion.
ALTER TABLE "Team"
DROP CONSTRAINT "Team_createdById_fkey";

ALTER TABLE "Team"
ADD CONSTRAINT "Team_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Transaction_teamId_idempotencyKey_key"
ON "Transaction"("teamId", "idempotencyKey");

ALTER TABLE "Transaction"
ADD CONSTRAINT "Transaction_amountInCents_positive_check"
CHECK ("amountInCents" > 0) NOT VALID;

ALTER TABLE "Transaction"
VALIDATE CONSTRAINT "Transaction_amountInCents_positive_check";

COMMIT;
