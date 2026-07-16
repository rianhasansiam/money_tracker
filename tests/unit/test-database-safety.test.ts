import { describe, expect, it } from "vitest";
import {
  TEST_DATABASE_DESTRUCTIVE_CONFIRMATION,
  assertDestructiveTestMode,
  scrubInheritedPostgresTargetOverrides,
  validateE2EBaseUrl,
  validateTestDatabaseEnvironment,
  validateTestEnvironment,
} from "../helpers/test-database-safety";

const LOCAL_TEST_URL =
  "postgresql://test_user@127.0.0.1:5432/money_tracker_test?schema=public";
const LOCAL_APP_URL =
  "postgresql://app_user@127.0.0.1:5432/money_tracker_development?schema=public";

function testEnvironment(
  overrides: Record<string, string | undefined> = {},
) {
  return {
    DATABASE_URL: LOCAL_APP_URL,
    TEST_DATABASE_URL: LOCAL_TEST_URL,
    ...overrides,
  };
}

describe("test database safety", () => {
  it("accepts a separate loopback database with an explicit test name", () => {
    expect(validateTestDatabaseEnvironment(testEnvironment())).toEqual({
      connectionString: LOCAL_TEST_URL,
      databaseName: "money_tracker_test",
      isRemote: false,
    });
  });

  it("requires TEST_DATABASE_URL", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({ TEST_DATABASE_URL: undefined }),
      ),
    ).toThrow(/TEST_DATABASE_URL is required/);
  });

  it("rejects the application database by canonical target identity", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          DATABASE_URL:
            "postgresql://other_user@localhost:5432/money_tracker_test?schema=other",
        }),
      ),
    ).toThrow(/identify the same database/);
  });

  it.each([
    "money_tracker_production_test",
    "money_tracker_staging_test",
    "money_tracker_live_test",
    "main_test",
    "primary_test",
    "postgres",
  ])("rejects production-looking or administrative database %s", (database) => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL: `postgresql://test_user@127.0.0.1:5432/${database}`,
        }),
      ),
    ).toThrow(/never allowed/);
  });

  it("requires explicit confirmation when the database name has no test segment", () => {
    const url =
      "postgresql://test_user@127.0.0.1:5432/money_tracker_sandbox";

    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({ TEST_DATABASE_URL: url }),
      ),
    ).toThrow(/exact destructive-test confirmation/);
    expect(
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL: url,
          TEST_DATABASE_CONFIRMATION:
            TEST_DATABASE_DESTRUCTIVE_CONFIRMATION,
        }),
      ),
    ).toMatchObject({ databaseName: "money_tracker_sandbox" });
  });

  it("requires explicit remote authorization, confirmation, and TLS", () => {
    const remoteUrl =
      "postgresql://test_user@ep-example.neon.tech/money_tracker_test";

    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({ TEST_DATABASE_URL: remoteUrl }),
      ),
    ).toThrow(/remote test databases require/);
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL: remoteUrl,
          TEST_DATABASE_ALLOW_REMOTE: "true",
          TEST_DATABASE_CONFIRMATION:
            TEST_DATABASE_DESTRUCTIVE_CONFIRMATION,
        }),
      ),
    ).toThrow(/require sslmode/);

    const approved = validateTestDatabaseEnvironment(
      testEnvironment({
        TEST_DATABASE_URL: `${remoteUrl}?sslmode=require`,
        TEST_DATABASE_ALLOW_REMOTE: "true",
        TEST_DATABASE_CONFIRMATION: TEST_DATABASE_DESTRUCTIVE_CONFIRMATION,
      }),
    );

    expect(approved).toMatchObject({
      databaseName: "money_tracker_test",
      isRemote: true,
    });
  });

  it("rejects production-looking remote hostnames even with confirmation", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL:
            "postgresql://test_user@production.example.test/money_tracker_test?sslmode=require",
          TEST_DATABASE_ALLOW_REMOTE: "true",
          TEST_DATABASE_CONFIRMATION:
            TEST_DATABASE_DESTRUCTIVE_CONFIRMATION,
        }),
      ),
    ).toThrow(/never allowed/);
  });

  it("rejects URL parameters that can override the selected database", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL: `${LOCAL_TEST_URL}&host=other.example.test`,
        }),
      ),
    ).toThrow(/override parameters/);
  });

  it("rejects session options that can redirect cleanup to another schema", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL: `${LOCAL_TEST_URL}&options=-c%20search_path%3Dprivate`,
        }),
      ),
    ).toThrow(/override parameters/);
  });

  it("rejects a query parameter that overrides the authority port", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL: `${LOCAL_TEST_URL}&port=6543`,
        }),
      ),
    ).toThrow(/override parameters/);
  });

  it("rejects an inherited PGPORT when the URL omits its port", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL:
            "postgresql://test_user@127.0.0.1/money_tracker_test?schema=public",
          PGPORT: "6543",
        }),
      ),
    ).toThrow(/target-affecting PostgreSQL environment variables.*PGPORT/);
  });

  it("rejects inherited PGOPTIONS that could redirect the search path", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          PGOPTIONS: "-c search_path=private",
        }),
      ),
    ).toThrow(/target-affecting PostgreSQL environment variables.*PGOPTIONS/);
  });

  it.each([
    "PGDATABASE",
    "PGHOST",
    "PGHOSTADDR",
    "PGLOADBALANCEHOSTS",
    "PGREPLICATION",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGSSLMODE",
    "PGTARGETSESSIONATTRS",
  ])("rejects inherited target control %s", (variableName) => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({ [variableName]: "unexpected-value" }),
      ),
    ).toThrow(new RegExp(variableName));
  });

  it("scrubs target-affecting PostgreSQL variables from child environments", () => {
    const environment = {
      PGHOST: "other.example.test",
      PGOPTIONS: "-c search_path=private",
      PGPORT: "6543",
      SAFE_VALUE: "retained",
    };

    scrubInheritedPostgresTargetOverrides(environment);

    expect(environment).toMatchObject({
      PGHOST: "",
      PGOPTIONS: "",
      PGPORT: "",
      SAFE_VALUE: "retained",
    });
  });

  it("rejects duplicate TLS parameters instead of trusting the first value", () => {
    expect(() =>
      validateTestDatabaseEnvironment(
        testEnvironment({
          TEST_DATABASE_URL:
            "postgresql://test_user@ep-example.neon.tech/money_tracker_test?sslmode=require&sslmode=disable",
          TEST_DATABASE_ALLOW_REMOTE: "true",
          TEST_DATABASE_CONFIRMATION:
            TEST_DATABASE_DESTRUCTIVE_CONFIRMATION,
        }),
      ),
    ).toThrow(/duplicate or override parameters/);
  });

  it("requires explicit test mode at destructive boundaries", () => {
    expect(() => assertDestructiveTestMode({ NODE_ENV: "production" })).toThrow(
      /require NODE_ENV=test/,
    );
    expect(() => assertDestructiveTestMode({ NODE_ENV: "test" })).not.toThrow();
  });

  it("accepts only a loopback HTTP origin for E2E", () => {
    expect(
      validateE2EBaseUrl({ E2E_BASE_URL: "http://127.0.0.1:3100" })
        .origin,
    ).toBe("http://127.0.0.1:3100");
    expect(() =>
      validateE2EBaseUrl({ E2E_BASE_URL: "https://example.test" }),
    ).toThrow(/loopback HTTP origin/);
  });

  it("validates database and E2E settings through one shared entry point", () => {
    expect(
      validateTestEnvironment(
        "e2e",
        testEnvironment({ E2E_BASE_URL: "http://localhost:3100" }),
      ),
    ).toMatchObject({
      database: { databaseName: "money_tracker_test" },
      baseUrl: { origin: "http://localhost:3100" },
    });
  });
});
