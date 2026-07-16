import { Client } from "pg";

export const TEST_DATABASE_DESTRUCTIVE_CONFIRMATION =
  "I_ACKNOWLEDGE_THIS_TEST_DATABASE_WILL_BE_CLEARED";

const LOCAL_DATABASE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);
const FORBIDDEN_CONNECTION_PARAMETERS = new Set([
  "database",
  "dbname",
  "host",
  "hostaddr",
  "options",
  "port",
  "search_path",
]);
const FORBIDDEN_DATABASE_NAMES = new Set([
  "postgres",
  "template0",
  "template1",
]);
const PRODUCTION_IDENTITY_TOKENS = new Set([
  "main",
  "primary",
  "prod",
  "production",
  "stage",
  "staging",
  "live",
]);
const REMOTE_TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);
const TEST_DATABASE_LOCK_NAMESPACE = 1_297_372_245;
const TEST_DATABASE_LOCK_ID = 1;
const TARGET_AFFECTING_POSTGRES_ENVIRONMENT_VARIABLES = [
  "PGDATABASE",
  "PGHOST",
  "PGHOSTADDR",
  "PGLOADBALANCEHOSTS",
  "PGOPTIONS",
  "PGPORT",
  "PGREPLICATION",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLMODE",
  "PGTARGETSESSIONATTRS",
] as const;

export type TestEnvironmentMode = "database" | "e2e";

export interface ApprovedTestDatabase {
  readonly connectionString: string;
  readonly databaseName: string;
  readonly isRemote: boolean;
}

export interface TestDatabaseLease {
  release(): Promise<void>;
}

type Environment = Readonly<Record<string, string | undefined>>;
type MutableEnvironment = Record<string, string | undefined>;

interface ParsedDatabaseTarget {
  readonly connectionString: string;
  readonly databaseName: string;
  readonly hostname: string;
  readonly identity: string;
  readonly isRemote: boolean;
  readonly url: URL;
}

function databaseSafetyError(message: string): Error {
  return new Error(`Test database safety check failed: ${message}`);
}

function assertNoInheritedPostgresTargetOverrides(
  environment: Environment = process.env,
) {
  const configuredOverrides =
    TARGET_AFFECTING_POSTGRES_ENVIRONMENT_VARIABLES.filter(
      (variableName) => environment[variableName]?.trim(),
    );

  if (configuredOverrides.length > 0) {
    throw databaseSafetyError(
      `target-affecting PostgreSQL environment variables must be unset; configure the test target only in TEST_DATABASE_URL (${configuredOverrides.join(", ")}).`,
    );
  }
}

export function scrubInheritedPostgresTargetOverrides(
  environment: MutableEnvironment,
) {
  for (const variableName of TARGET_AFFECTING_POSTGRES_ENVIRONMENT_VARIABLES) {
    environment[variableName] = "";
  }
}

function parseDatabaseTarget(
  connectionString: string,
  variableName: string,
): ParsedDatabaseTarget {
  if (
    connectionString.length === 0 ||
    connectionString !== connectionString.trim()
  ) {
    throw databaseSafetyError(`${variableName} is missing or malformed.`);
  }

  let url: URL;

  try {
    url = new URL(connectionString);
  } catch {
    throw databaseSafetyError(`${variableName} is not a valid PostgreSQL URL.`);
  }

  const connectionParameterNames = [...url.searchParams.keys()].map(
    (parameter) => parameter.toLowerCase(),
  );
  const hasDuplicateConnectionParameter =
    new Set(connectionParameterNames).size !== connectionParameterNames.length;

  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    url.hash ||
    hasDuplicateConnectionParameter ||
    connectionParameterNames.some((parameter) =>
      FORBIDDEN_CONNECTION_PARAMETERS.has(parameter),
    )
  ) {
    throw databaseSafetyError(
      `${variableName} must identify one PostgreSQL database without duplicate or override parameters.`,
    );
  }

  const encodedDatabaseName = url.pathname.slice(1);
  let databaseName: string;

  try {
    databaseName = decodeURIComponent(encodedDatabaseName);
  } catch {
    throw databaseSafetyError(`${variableName} has an invalid database name.`);
  }

  if (
    encodedDatabaseName.length === 0 ||
    databaseName.includes("/") ||
    !/^[a-z0-9_-]+$/i.test(databaseName)
  ) {
    throw databaseSafetyError(
      `${variableName} must contain one explicit database name.`,
    );
  }

  const hostname = url.hostname.toLowerCase();
  const normalizedHostname = LOCAL_DATABASE_HOSTS.has(hostname)
    ? "loopback"
    : hostname;
  const port = url.port || "5432";

  return {
    connectionString,
    databaseName,
    hostname,
    identity: `${normalizedHostname}:${port}/${databaseName.toLowerCase()}`,
    isRemote: !LOCAL_DATABASE_HOSTS.has(hostname),
    url,
  };
}

function containsProductionIdentityToken(value: string): boolean {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => PRODUCTION_IDENTITY_TOKENS.has(token));
}

function hasTestDatabaseName(databaseName: string): boolean {
  return /(^|[_-])test(?:ing)?([_-]|$)/i.test(databaseName);
}

function hasDestructiveConfirmation(environment: Environment): boolean {
  return (
    environment.TEST_DATABASE_CONFIRMATION?.trim() ===
    TEST_DATABASE_DESTRUCTIVE_CONFIRMATION
  );
}

export function validateTestDatabaseEnvironment(
  environment: Environment = process.env,
): ApprovedTestDatabase {
  assertNoInheritedPostgresTargetOverrides(environment);
  const configuredUrl = environment.TEST_DATABASE_URL;

  if (!configuredUrl) {
    throw databaseSafetyError(
      "TEST_DATABASE_URL is required for PostgreSQL tests.",
    );
  }

  const target = parseDatabaseTarget(configuredUrl, "TEST_DATABASE_URL");
  const schemaName = target.url.searchParams.get("schema") ?? "public";

  if (
    FORBIDDEN_DATABASE_NAMES.has(target.databaseName.toLowerCase()) ||
    containsProductionIdentityToken(target.hostname) ||
    containsProductionIdentityToken(target.databaseName) ||
    containsProductionIdentityToken(schemaName)
  ) {
    throw databaseSafetyError(
      "production-, staging-, live-, primary-, or administrative-looking targets are never allowed.",
    );
  }

  const applicationUrl = environment.DATABASE_URL;

  if (applicationUrl?.trim()) {
    const applicationTarget = parseDatabaseTarget(
      applicationUrl,
      "DATABASE_URL",
    );

    if (applicationTarget.identity === target.identity) {
      throw databaseSafetyError(
        "TEST_DATABASE_URL and DATABASE_URL identify the same database.",
      );
    }
  }

  const confirmed = hasDestructiveConfirmation(environment);

  if (!hasTestDatabaseName(target.databaseName) && !confirmed) {
    throw databaseSafetyError(
      "the database name must contain a test segment unless the exact destructive-test confirmation is supplied.",
    );
  }

  if (target.isRemote) {
    const remoteAllowed =
      environment.TEST_DATABASE_ALLOW_REMOTE?.trim().toLowerCase() === "true";
    const tlsMode = target.url.searchParams.get("sslmode")?.toLowerCase();

    if (!remoteAllowed || !confirmed) {
      throw databaseSafetyError(
        "remote test databases require TEST_DATABASE_ALLOW_REMOTE=true and the exact destructive-test confirmation.",
      );
    }

    if (!tlsMode || !REMOTE_TLS_MODES.has(tlsMode)) {
      throw databaseSafetyError(
        "remote test databases require sslmode=require, verify-ca, or verify-full.",
      );
    }
  }

  return {
    connectionString: target.connectionString,
    databaseName: target.databaseName,
    isRemote: target.isRemote,
  };
}

export function assertDestructiveTestMode(
  environment: Environment = process.env,
) {
  if (environment.NODE_ENV !== "test") {
    throw databaseSafetyError(
      "destructive test preparation and cleanup require NODE_ENV=test.",
    );
  }
}

export function validateE2EBaseUrl(
  environment: Environment = process.env,
): URL {
  const configuredUrl = environment.E2E_BASE_URL?.trim();

  if (!configuredUrl) {
    throw new Error("E2E_BASE_URL is required for browser and route tests.");
  }

  let url: URL;

  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("E2E_BASE_URL must be a loopback HTTP origin.");
  }

  if (
    url.protocol !== "http:" ||
    !LOCAL_DATABASE_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("E2E_BASE_URL must be a loopback HTTP origin.");
  }

  return url;
}

export function validateTestEnvironment(
  mode: TestEnvironmentMode,
  environment: Environment = process.env,
) {
  const database = validateTestDatabaseEnvironment(environment);

  return {
    database,
    baseUrl: mode === "e2e" ? validateE2EBaseUrl(environment) : undefined,
  };
}

export async function acquireTestDatabaseLease(
  approvedDatabase: ApprovedTestDatabase,
): Promise<TestDatabaseLease> {
  assertNoInheritedPostgresTargetOverrides();
  const client = new Client({
    connectionString: approvedDatabase.connectionString,
  });

  try {
    await client.connect();
    const databaseResult = await client.query<{ databaseName: string }>(
      'SELECT current_database() AS "databaseName"',
    );

    if (
      databaseResult.rows.length !== 1 ||
      databaseResult.rows[0]?.databaseName !== approvedDatabase.databaseName
    ) {
      throw databaseSafetyError(
        "the connected database does not match TEST_DATABASE_URL.",
      );
    }

    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
      [TEST_DATABASE_LOCK_NAMESPACE, TEST_DATABASE_LOCK_ID],
    );

    if (lockResult.rows[0]?.acquired !== true) {
      throw databaseSafetyError(
        "another test process already holds the database cleanup lease.",
      );
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  let released = false;

  return {
    async release() {
      if (released) {
        return;
      }

      released = true;
      let releaseFailed = false;

      try {
        await client.query(
          "SELECT pg_advisory_unlock($1::integer, $2::integer)",
          [TEST_DATABASE_LOCK_NAMESPACE, TEST_DATABASE_LOCK_ID],
        );
      } catch {
        releaseFailed = true;
      }

      try {
        await client.end();
      } catch {
        releaseFailed = true;
      }

      if (releaseFailed) {
        throw databaseSafetyError(
          "the database cleanup lease could not be released cleanly.",
        );
      }
    },
  };
}
