import "dotenv/config";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  scrubInheritedPostgresTargetOverrides,
  validateTestEnvironment,
} from "../tests/helpers/test-database-safety";

const require = createRequire(import.meta.url);
const nextCliPath = require.resolve("next/dist/bin/next");

function createServerEnvironment(connectionString: string, baseUrl: URL) {
  const environment = { ...process.env };

  // Next loads ignored environment files during startup. Empty sentinels keep
  // destructive-test controls out of the production-mode server process.
  environment.TEST_DATABASE_URL = "";
  environment.TEST_DATABASE_ALLOW_REMOTE = "";
  environment.TEST_DATABASE_CONFIRMATION = "";
  scrubInheritedPostgresTargetOverrides(environment);
  environment.DATABASE_URL = connectionString;
  environment.NODE_ENV = "production";
  if (environment.VERCEL !== "1") {
    environment.AUTH_URL = baseUrl.origin;
  }
  environment.HOSTNAME = baseUrl.hostname.replace(/^\[|\]$/g, "");
  environment.PORT = baseUrl.port || "80";

  return environment;
}

const { database, baseUrl } = validateTestEnvironment("e2e");

if (!baseUrl) {
  throw new Error("The test server requires E2E_BASE_URL.");
}

const hostname = baseUrl.hostname.replace(/^\[|\]$/g, "");
const port = baseUrl.port || "80";
const standalone = process.argv.includes("--standalone");
const standaloneServer = resolve(".next/standalone/server.js");
if (standalone && !existsSync(standaloneServer)) {
  throw new Error("Build and verify the standalone artifact before starting it.");
}
const child = spawn(
  process.execPath,
  standalone
    ? [standaloneServer]
    : [nextCliPath, "start", "--hostname", hostname, "--port", port],
  {
    env: createServerEnvironment(database.connectionString, baseUrl),
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

child.once("error", () => {
  console.error("The production test server could not be started.");
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
