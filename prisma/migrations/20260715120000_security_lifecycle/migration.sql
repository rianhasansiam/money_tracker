-- Security lifecycle migration: establish explicit application admission,
-- bounded sessions, recoverable team deletion metadata, durable rate-limit
-- counters, and append-only administrative audit history.
--
-- DEPLOYMENT ORDER
-- 1. Take and verify a restorable database backup.
-- 2. Deploy this migration before the application release. Existing users are
--    backfilled to ACTIVE (or their existing disabled/deleted state), while the
--    database default remains PENDING so an unprovisioned adapter-created user
--    can never become active by default.
-- 3. Deploy the compatible application. It hashes every session lookup token
--    before database access and never persists provider bearer tokens.
-- 4. Verify active-user counts by status, session counts, and migration status
--    without selecting identities, session values, or OAuth account material.
--
-- Existing database session tokens are transformed in place to their SHA-256
-- digest. The browser's existing opaque cookie continues to work because the
-- compatible adapter applies the same one-way transform on every lookup.
-- Provider bearer/token metadata is intentionally cleared because this
-- application does not call Google APIs after authentication. No user, team,
-- membership, transaction, or financial amount is removed.
--
-- ROLLBACK / RECOVERY
-- Prefer forward recovery. Reverting to an adapter that looks up raw session
-- tokens would require users to sign in again because SHA-256 is one-way. A
-- rollback may safely retain the additive lifecycle/audit/rate-limit tables,
-- nullable team metadata, and provider-token minimization. Do not drop audit
-- history as part of an application rollback. The audit trigger has no
-- application-settable bypass and also blocks TRUNCATE. Any exceptional legal
-- retention operation must run under the separately controlled table-owner
-- identity, explicitly disable the trigger inside a reviewed transaction, and
-- preserve the database/identity-provider audit record of that operation.

BEGIN;

CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'DELETED');
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

ALTER TYPE "TeamMembershipStatus" ADD VALUE IF NOT EXISTS 'REVOKED';

-- Admission compares normalized email addresses. Fail before changing data if
-- legacy case/whitespace variants would collapse to the same identity, then
-- canonicalize the remaining values and enforce that invariant at the DB edge.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "User"
        WHERE "email" IS NOT NULL
        GROUP BY LOWER(BTRIM("email"))
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Case-insensitive duplicate user emails must be resolved before admission migration.';
    END IF;
END
$$;

UPDATE "User"
SET "email" = LOWER(BTRIM("email"))
WHERE "email" IS NOT NULL;

ALTER TABLE "User"
ADD CONSTRAINT "User_email_canonical_check"
CHECK (
    "email" IS NULL
    OR (
        "email" = LOWER(BTRIM("email"))
        AND CHAR_LENGTH("email") BETWEEN 3 AND 254
    )
) NOT VALID;

ALTER TABLE "User"
VALIDATE CONSTRAINT "User_email_canonical_check";

ALTER TABLE "User"
ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "lastAuthenticatedAt" TIMESTAMP(3);

-- Preserve all previously authorized users. Existing lifecycle timestamps are
-- authoritative; normalize a deleted row's disabled timestamp before adding
-- the state-consistency constraint.
UPDATE "User"
SET "disabledAt" = COALESCE("disabledAt", "deletedAt")
WHERE "deletedAt" IS NOT NULL;

UPDATE "User"
SET "status" = CASE
    WHEN "deletedAt" IS NOT NULL THEN 'DELETED'::"UserStatus"
    WHEN "disabledAt" IS NOT NULL THEN 'DISABLED'::"UserStatus"
    ELSE 'ACTIVE'::"UserStatus"
END;

ALTER TABLE "User"
ADD CONSTRAINT "User_lifecycle_state_check"
CHECK (
    (
        "status" IN ('PENDING'::"UserStatus", 'ACTIVE'::"UserStatus")
        AND "disabledAt" IS NULL
        AND "deletedAt" IS NULL
    )
    OR (
        "status" = 'DISABLED'::"UserStatus"
        AND "disabledAt" IS NOT NULL
        AND "deletedAt" IS NULL
    )
    OR (
        "status" = 'DELETED'::"UserStatus"
        AND "disabledAt" IS NOT NULL
        AND "deletedAt" IS NOT NULL
    )
) NOT VALID;

ALTER TABLE "User"
VALIDATE CONSTRAINT "User_lifecycle_state_check";

ALTER TABLE "Session"
ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- PostgreSQL's core SHA-256 function matches Node's SHA-256 over UTF-8 bytes.
-- The uniqueness constraint remains valid because the transform is
-- deterministic and collision resistant for randomly generated session data.
-- Cap legacy expirations at the application's new eight-hour maximum so a
-- previously issued 30-day session cannot retain its old lifetime.
UPDATE "Session"
SET
    "expires" = LEAST(
        "expires",
        CURRENT_TIMESTAMP + INTERVAL '8 hours'
    ),
    "sessionToken" = encode(
        sha256(convert_to("sessionToken", 'UTF8')),
        'hex'
    );

-- This application uses Google only to authenticate an identity and never
-- calls a provider API after sign-in, so retaining these values has no product
-- purpose and unnecessarily increases database-compromise impact.
UPDATE "Account"
SET
    "refresh_token" = NULL,
    "access_token" = NULL,
    "expires_at" = NULL,
    "token_type" = NULL,
    "scope" = NULL,
    "id_token" = NULL,
    "session_state" = NULL;

ALTER TABLE "Team"
ADD COLUMN "deletedById" TEXT,
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "purgeAfter" TIMESTAMP(3);

ALTER TABLE "Team"
ADD CONSTRAINT "Team_deletion_state_check"
CHECK (
    (
        "deletedAt" IS NULL
        AND "purgeAfter" IS NULL
        AND "deletedById" IS NULL
    )
    OR (
        "deletedAt" IS NOT NULL
        AND "purgeAfter" IS NOT NULL
        AND "purgeAfter" > "deletedAt"
    )
) NOT VALID;

ALTER TABLE "Team"
VALIDATE CONSTRAINT "Team_deletion_state_check";

CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "provisionedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Invitation_canonical_email_check" CHECK (
        "email" = LOWER(BTRIM("email"))
        AND CHAR_LENGTH("email") BETWEEN 3 AND 254
    ),
    CONSTRAINT "Invitation_lifecycle_check" CHECK (
        (
            "status" = 'PENDING'::"InvitationStatus"
            AND "acceptedAt" IS NULL
            AND "revokedAt" IS NULL
        )
        OR (
            "status" = 'ACCEPTED'::"InvitationStatus"
            AND "acceptedAt" IS NOT NULL
            AND "revokedAt" IS NULL
        )
        OR (
            "status" = 'REVOKED'::"InvitationStatus"
            AND "acceptedAt" IS NULL
            AND "revokedAt" IS NOT NULL
        )
    ),
    CONSTRAINT "Invitation_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "actorUserId" VARCHAR(191),
    "actorIdSnapshot" VARCHAR(191) NOT NULL,
    "actorNameSnapshot" VARCHAR(160) NOT NULL,
    "targetType" VARCHAR(40) NOT NULL,
    "targetIdSnapshot" VARCHAR(191) NOT NULL,
    "teamIdSnapshot" VARCHAR(191),
    "correlationId" VARCHAR(64) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "subjectHash" VARCHAR(64) NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RateLimitBucket_count_check" CHECK ("count" >= 0),
    CONSTRAINT "RateLimitBucket_expiry_check" CHECK ("expiresAt" > "windowStart")
);

CREATE UNIQUE INDEX "Invitation_email_key" ON "Invitation"("email");
CREATE UNIQUE INDEX "Invitation_provisionedUserId_key" ON "Invitation"("provisionedUserId");
CREATE INDEX "Invitation_status_expiresAt_idx" ON "Invitation"("status", "expiresAt");
CREATE INDEX "Invitation_invitedById_idx" ON "Invitation"("invitedById");

CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");
CREATE INDEX "AuditEvent_targetType_targetIdSnapshot_createdAt_idx" ON "AuditEvent"("targetType", "targetIdSnapshot", "createdAt");
CREATE INDEX "AuditEvent_teamIdSnapshot_createdAt_idx" ON "AuditEvent"("teamIdSnapshot", "createdAt");
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

CREATE UNIQUE INDEX "RateLimitBucket_scope_subjectHash_windowStart_key"
ON "RateLimitBucket"("scope", "subjectHash", "windowStart");
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");

DROP INDEX "Transaction_teamId_transactionDate_createdAt_idx";
CREATE INDEX "Transaction_teamId_transactionDate_createdAt_id_idx"
ON "Transaction"("teamId", "transactionDate", "createdAt", "id");
CREATE INDEX "Transaction_teamId_type_idx" ON "Transaction"("teamId", "type");

CREATE INDEX "Team_deletedAt_purgeAfter_idx" ON "Team"("deletedAt", "purgeAfter");
CREATE INDEX "Team_deletedById_idx" ON "Team"("deletedById");

ALTER TABLE "Team"
ADD CONSTRAINT "Team_deletedById_fkey"
FOREIGN KEY ("deletedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invitation"
ADD CONSTRAINT "Invitation_invitedById_fkey"
FOREIGN KEY ("invitedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invitation"
ADD CONSTRAINT "Invitation_provisionedUserId_fkey"
FOREIGN KEY ("provisionedUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION prevent_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are append-only.'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "AuditEvent_append_only_trigger"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "AuditEvent"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_event_mutation();

COMMIT;
