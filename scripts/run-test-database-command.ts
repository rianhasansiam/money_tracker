import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  acquireTestDatabaseLease,
  scrubInheritedPostgresTargetOverrides,
  validateTestDatabaseEnvironment,
} from "../tests/helpers/test-database-safety";

const PRISMA_COMMANDS = {
  deploy: ["migrate", "deploy"],
  status: ["migrate", "status"],
} as const;
const require = createRequire(import.meta.url);
const prismaCliPath = require.resolve("prisma/build/index.js");

type TestDatabaseCommand = keyof typeof PRISMA_COMMANDS;

function createPrismaEnvironment(connectionString: string) {
  const environment = { ...process.env };

  // Empty sentinels prevent Prisma's dotenv-loaded config from reintroducing
  // test-only values into the child after validation.
  environment.TEST_DATABASE_URL = "";
  environment.TEST_DATABASE_ALLOW_REMOTE = "";
  environment.TEST_DATABASE_CONFIRMATION = "";
  scrubInheritedPostgresTargetOverrides(environment);
  environment.DATABASE_URL = connectionString;
  environment.NODE_ENV = "test";

  return environment;
}

async function main() {
  const requestedCommand = process.argv[2] as TestDatabaseCommand | undefined;

  if (!requestedCommand || !(requestedCommand in PRISMA_COMMANDS)) {
    throw new Error("Unknown test database command.");
  }

  const approvedDatabase = validateTestDatabaseEnvironment();
  const lease = await acquireTestDatabaseLease(approvedDatabase);

  try {
    const result = spawnSync(
      process.execPath,
      [prismaCliPath, ...PRISMA_COMMANDS[requestedCommand]],
      {
        env: createPrismaEnvironment(approvedDatabase.connectionString),
        stdio: "inherit",
      },
    );

    if (result.error) {
      throw new Error("The Prisma test database command could not be started.");
    }

    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    }
  } finally {
    await lease.release();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "The test database command failed safely.",
  );
  process.exitCode = 1;
});
