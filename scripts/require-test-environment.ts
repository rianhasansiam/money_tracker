import "dotenv/config";
import {
  validateTestEnvironment,
  type TestEnvironmentMode,
} from "../tests/helpers/test-database-safety";

const requestedMode = process.argv[2];

if (requestedMode !== "database" && requestedMode !== "e2e") {
  console.error("Unknown test-environment validation mode.");
  process.exitCode = 1;
} else {
  try {
    validateTestEnvironment(requestedMode satisfies TestEnvironmentMode);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "The test environment could not be validated safely.",
    );
    process.exitCode = 1;
  }
}
