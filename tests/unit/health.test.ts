import { describe, expect, it, vi } from "vitest";
import { GET as getHealth } from "@/app/api/health/route";

const readinessMocks = vi.hoisted(() => ({
  check: vi.fn(),
}));

vi.mock("@/lib/readiness", () => ({
  checkDatabaseReadiness: readinessMocks.check,
}));

import { GET as getReadiness } from "@/app/api/ready/route";

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
    expect(readinessMocks.check).not.toHaveBeenCalled();
  });

  it("returns ready without serializing database details", async () => {
    readinessMocks.check.mockResolvedValueOnce(true);

    const response = await getReadiness();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(readinessMocks.check).toHaveBeenCalledTimes(1);
  });

  it("returns a generic 503 and correlated warning when the database is unavailable", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    readinessMocks.check.mockResolvedValueOnce(false);

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
});
