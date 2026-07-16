-- Correct the persisted moderator-role typo without replacing either enum,
-- rewriting dependent tables, or changing row identity. PostgreSQL's
-- ALTER TYPE ... RENAME VALUE retains the enum type/value OIDs, so existing
-- User and TeamMembership rows keep the same role and permissions.
--
-- DEPLOYMENT ORDER
-- 1. Take and verify a restorable backup.
-- 2. Quiesce old application writers. The old release still sends the legacy
--    label and is not compatible after this migration commits.
-- 3. Run `prisma migrate deploy` with PostgreSQL 10 or newer.
-- 4. Deploy the release whose Prisma Client and authorization checks use
--    MODERATOR, then verify moderator access before re-enabling traffic.
--
-- ROLLBACK / RECOVERY
-- Prefer forward recovery: this block is restart-safe when both labels were
-- already renamed, and its transaction prevents a one-enum partial commit.
-- If the application must be rolled back, quiesce traffic and apply the exact
-- inverse RENAME VALUE operations before starting the old release. Do not add
-- both spellings or cast through text; either approach can split one logical
-- permission role into two persisted values.

BEGIN;

DO $moderator_enum_rename$
DECLARE
    user_role_type OID := TO_REGTYPE('"UserRole"');
    team_role_type OID := TO_REGTYPE('"TeamMemberRole"');
BEGIN
    IF CURRENT_SETTING('server_version_num')::INTEGER < 100000 THEN
        RAISE EXCEPTION 'Moderator enum rename requires PostgreSQL 10 or newer.';
    END IF;

    IF user_role_type IS NULL OR team_role_type IS NULL THEN
        RAISE EXCEPTION 'Required role enum types are missing; refusing an unsafe compatibility migration.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = user_role_type AND enumlabel = 'MODARETOR'
    ) AND EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = user_role_type AND enumlabel = 'MODERATOR'
    ) THEN
        RAISE EXCEPTION 'UserRole contains both moderator spellings; reconcile the conflicting values before migrating.';
    ELSIF EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = user_role_type AND enumlabel = 'MODARETOR'
    ) THEN
        EXECUTE 'ALTER TYPE "UserRole" RENAME VALUE ''MODARETOR'' TO ''MODERATOR''';
    ELSIF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = user_role_type AND enumlabel = 'MODERATOR'
    ) THEN
        RAISE EXCEPTION 'UserRole has no recognized moderator value; refusing to guess.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = team_role_type AND enumlabel = 'MODARETOR'
    ) AND EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = team_role_type AND enumlabel = 'MODERATOR'
    ) THEN
        RAISE EXCEPTION 'TeamMemberRole contains both moderator spellings; reconcile the conflicting values before migrating.';
    ELSIF EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = team_role_type AND enumlabel = 'MODARETOR'
    ) THEN
        EXECUTE 'ALTER TYPE "TeamMemberRole" RENAME VALUE ''MODARETOR'' TO ''MODERATOR''';
    ELSIF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = team_role_type AND enumlabel = 'MODERATOR'
    ) THEN
        RAISE EXCEPTION 'TeamMemberRole has no recognized moderator value; refusing to guess.';
    END IF;
END
$moderator_enum_rename$;

COMMIT;
