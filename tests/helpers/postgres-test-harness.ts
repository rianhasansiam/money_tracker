import {
  acquireTestDatabaseLease,
  assertDestructiveTestMode,
  validateTestDatabaseEnvironment,
  type TestDatabaseLease,
} from "./test-database-safety";

export const POSTGRES_TEST_SKIP_REASON =
  "Skipped: TEST_DATABASE_URL is not configured for a dedicated disposable PostgreSQL test database.";

export type AppDatabase = (typeof import("@/lib/db"))["db"];

export interface PostgresTestHarness {
  readonly db: AppDatabase;
  clean(): Promise<void>;
  close(): Promise<void>;
}

const REQUIRED_SCHEMA_COLUMN_COUNT = 21;

function restoreDatabaseUrl(previousDatabaseUrl: string | undefined) {
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
    return;
  }

  process.env.DATABASE_URL = previousDatabaseUrl;
}

function clearOwnedGlobalClient(db: AppDatabase) {
  if (Reflect.get(globalThis, "prisma") === db) {
    Reflect.deleteProperty(globalThis, "prisma");
    Reflect.deleteProperty(globalThis, "prismaSchemaSignature");
  }
}

async function assertConnectedToApprovedDatabase(
  db: AppDatabase,
  approvedDatabaseName: string,
) {
  const rows = await db.$queryRaw<Array<{ databaseName: string }>>`
    SELECT current_database() AS "databaseName"
  `;

  if (rows.length !== 1 || rows[0]?.databaseName !== approvedDatabaseName) {
    throw new Error("PostgreSQL integration test database safety check failed.");
  }
}

async function assertCurrentSchema(db: AppDatabase) {
  const rows = await db.$queryRaw<Array<{ requiredColumnCount: number }>>`
    SELECT COUNT(*)::integer AS "requiredColumnCount"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (table_name, column_name) IN (
        ('User', 'id'),
        ('User', 'status'),
        ('User', 'lastAuthenticatedAt'),
        ('User', 'disabledAt'),
        ('User', 'deletedAt'),
        ('Session', 'createdAt'),
        ('Team', 'id'),
        ('Team', 'createdById'),
        ('Team', 'deletedAt'),
        ('Team', 'purgeAfter'),
        ('TeamMembership', 'id'),
        ('Transaction', 'id'),
        ('Transaction', 'idempotencyKey'),
        ('Transaction', 'actorIdSnapshot'),
        ('Transaction', 'actorNameSnapshot'),
        ('Transaction', 'amountInCents'),
        ('Invitation', 'id'),
        ('Invitation', 'status'),
        ('AuditEvent', 'id'),
        ('RateLimitBucket', 'id'),
        ('RateLimitBucket', 'subjectHash')
      )
  `;

  if (rows[0]?.requiredColumnCount !== REQUIRED_SCHEMA_COLUMN_COUNT) {
    throw new Error(
      "The disposable PostgreSQL test database is not migrated to the current schema.",
    );
  }
}

async function cleanApprovedDatabase(
  db: AppDatabase,
  approvedDatabaseName: string,
) {
  assertDestructiveTestMode();
  await assertConnectedToApprovedDatabase(db, approvedDatabaseName);

  await db.$transaction(async (tx) => {
    // The application-facing audit trigger has no bypass. This harness runs
    // only against a verified disposable test database using its owner-level
    // test identity, so it can temporarily disable and re-enable the trigger
    // transactionally. A failure rolls back both the cleanup and trigger state.
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only_trigger"',
    );
    await tx.rateLimitBucket.deleteMany();
    await tx.auditEvent.deleteMany();
    await tx.transaction.deleteMany();
    await tx.teamMembership.deleteMany();
    await tx.team.deleteMany();
    await tx.invitation.deleteMany();
    await tx.account.deleteMany();
    await tx.session.deleteMany();
    await tx.authenticator.deleteMany();
    await tx.verificationToken.deleteMany();
    await tx.user.deleteMany();
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only_trigger"',
    );
  });
}

export function isPostgresTestDatabaseConfigured() {
  return Boolean(process.env.TEST_DATABASE_URL?.trim());
}

export async function openPostgresTestHarness(): Promise<PostgresTestHarness> {
  assertDestructiveTestMode();
  const approvedDatabase = validateTestDatabaseEnvironment();

  if (Reflect.get(globalThis, "prisma") !== undefined) {
    throw new Error(
      "PostgreSQL integration tests require an isolated worker with no preloaded application database client.",
    );
  }

  let lease: TestDatabaseLease | undefined;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let db: AppDatabase | undefined;

  try {
    lease = await acquireTestDatabaseLease(approvedDatabase);
    process.env.DATABASE_URL = approvedDatabase.connectionString;
    ({ db } = await import("@/lib/db"));
    await assertConnectedToApprovedDatabase(db, approvedDatabase.databaseName);
    await assertCurrentSchema(db);
  } catch {
    if (db) {
      await db.$disconnect().catch(() => undefined);
      clearOwnedGlobalClient(db);
    }

    await lease?.release().catch(() => undefined);
    restoreDatabaseUrl(previousDatabaseUrl);
    throw new Error(
      "Could not initialize the disposable PostgreSQL test database. Verify the dedicated database exists, is not in use, and migrations are current.",
    );
  }

  let closed = false;

  return {
    db,
    async clean() {
      if (closed) {
        throw new Error("The PostgreSQL integration test harness is closed.");
      }

      await cleanApprovedDatabase(db, approvedDatabase.databaseName);
    },
    async close() {
      if (closed) {
        return;
      }

      let cleanupFailed = false;

      try {
        await cleanApprovedDatabase(db, approvedDatabase.databaseName);
      } catch {
        cleanupFailed = true;
      }

      try {
        await db.$disconnect();
      } catch {
        cleanupFailed = true;
      }

      try {
        await lease?.release();
      } catch {
        cleanupFailed = true;
      } finally {
        closed = true;
        clearOwnedGlobalClient(db);
        restoreDatabaseUrl(previousDatabaseUrl);
      }

      if (cleanupFailed) {
        throw new Error(
          "The disposable PostgreSQL test database could not be cleaned safely.",
        );
      }
    },
  };
}
