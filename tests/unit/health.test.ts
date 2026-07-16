import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getHealth } from "@/app/api/health/route";
import { runReadinessProbe } from "@/lib/health";

const databaseMocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: databaseMocks.queryRaw,
  },
}));

import { GET as getReadiness } from "@/app/api/ready/route";

afterEach(() => {
  vi.useRealTimers();
});

describe("health and readiness", () => {
  it("returns a generic, uncached liveness response", async () => {
    const response = getHealth();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("x-correlation-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex, noarchive");
  });

  it("returns ready without serializing database details", async () => {
    databaseMocks.queryRaw.mockResolvedValueOnce([{ ready: 1 }]);

    const response = await getReadiness();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(databaseMocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns a generic 503 and correlated warning when the database is unavailable", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    databaseMocks.queryRaw.mockRejectedValueOnce(
      new Error("postgresql://user:password@private-host/database"),
    );

    const response = await getReadiness();
    const body = await response.json();
    const warning = JSON.parse(String(consoleWarn.mock.calls[0]?.[0]));

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "unavailable" });
    expect(JSON.stringify(body)).not.toContain("private-host");
    expect(warning).toMatchObject({
      category: "dependency_unavailable",
      event: "readiness_check_failed",
      correlationId: response.headers.get("x-correlation-id"),
    });
  });

  it("fails a stalled readiness dependency within the configured bound", async () => {
    vi.useFakeTimers();

    const result = runReadinessProbe(
      () => new Promise(() => undefined),
      25,
    );

    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe(false);
  });
});

