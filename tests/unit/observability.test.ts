import { describe, expect, it, vi } from "vitest";
import {
  formatPublicErrorReference,
  logServerError,
  redactSensitiveValue,
  reportUnexpectedError,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";

const CORRELATION_ID = "6d7fca71-76f8-4c06-9bc6-bad1d51a677f";

describe("structured observability", () => {
  it("redacts credentials, identifiers, personal data, and financial values", () => {
    const result = redactSensitiveValue({
      authorization: "Bearer provider-token",
      cookie: "authjs.session-token=session-secret",
      databaseUrl: "postgresql://user:password@database.example/app",
      accessToken: "oauth-access-token",
      userId: "user-private-id",
      teamId: "team-private-id",
      amountInCents: 123_45,
      note: "private transaction note",
      message:
        "Contact owner@example.com or use postgresql://user:pass@host/db",
      operation: "readiness_check",
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("provider-token");
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("oauth-access-token");
    expect(serialized).not.toContain("user-private-id");
    expect(serialized).not.toContain("team-private-id");
    expect(serialized).not.toContain("private transaction note");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("12345");
    expect(serialized).toContain("readiness_check");
  });

  it("logs a structured error without the exception message or stack", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const error = new Error(
      "SQL failed for postgresql://user:password@host/database and owner@example.com",
    );

    const correlationId = logServerError(
      SERVER_ERROR_CATEGORY.dependencyUnavailable,
      error,
      {
        correlationId: CORRELATION_ID,
        context: { routePath: "/api/ready" },
      },
    );
    const payload = JSON.parse(String(consoleError.mock.calls[0]?.[0]));

    expect(correlationId).toBe(CORRELATION_ID);
    expect(payload).toMatchObject({
      level: "error",
      category: "dependency_unavailable",
      correlationId: CORRELATION_ID,
      event: "server_error",
      context: {
        routePath: "/api/ready",
        error: { name: "Error" },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("SQL failed");
    expect(JSON.stringify(payload)).not.toContain("password");
    expect(JSON.stringify(payload)).not.toContain("owner@example.com");
    expect(JSON.stringify(payload)).not.toContain("stack");
  });

  it("returns a stable public reference for unexpected action errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = reportUnexpectedError(new Error("private database detail"), {
      correlationId: CORRELATION_ID,
    });

    expect(result).toEqual({
      correlationId: CORRELATION_ID,
      message: formatPublicErrorReference(CORRELATION_ID),
    });
    expect(result.message).toContain(`Reference: ${CORRELATION_ID}`);
    expect(result.message).not.toContain("database detail");
  });

  it("does not let hostile context values or a logging sink alter control flow", () => {
    const hostileContext = {};
    Object.defineProperty(hostileContext, "value", {
      enumerable: true,
      get() {
        throw new Error("getter secret");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("logging sink unavailable");
    });

    expect(redactSensitiveValue(hostileContext)).toBe(
      "[UNSERIALIZABLE_REDACTED]",
    );
    expect(
      logServerError(SERVER_ERROR_CATEGORY.unexpected, new Error("private"), {
        correlationId: CORRELATION_ID,
        context: { hostileContext },
      }),
    ).toBe(CORRELATION_ID);
  });
});
