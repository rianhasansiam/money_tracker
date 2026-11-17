import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeHistoryCursor } from "@/lib/history-cursor";
import { normalizeHistoryFilters } from "@/lib/history-filters";

const dashboardActionMocks = vi.hoisted(() => {
  class RateLimitExceededError extends Error {
    constructor(public readonly retryAfterSeconds: number) {
      super("Rate limit exceeded.");
    }
  }
  class RateLimitUnavailableError extends Error {}

  return {
    auth: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    enforceUserRateLimit: vi.fn<() => Promise<unknown>>(),
    getTransactionHistoryPage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getDashboardData: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    RateLimitExceededError,
    RateLimitUnavailableError,
  };
});

vi.mock("@/lib/auth", () => ({
  auth: dashboardActionMocks.auth,
}));

vi.mock("@/lib/queries/dashboard", () => ({
  getTransactionHistoryPage: dashboardActionMocks.getTransactionHistoryPage,
  getDashboardData: dashboardActionMocks.getDashboardData,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: dashboardActionMocks.enforceUserRateLimit,
  RateLimitExceededError: dashboardActionMocks.RateLimitExceededError,
  RateLimitUnavailableError: dashboardActionMocks.RateLimitUnavailableError,
}));

import { loadFilteredDashboard, loadMoreTransactionHistory } from "@/actions/dashboard";

const teamId = "clh1234567890abcdefghijk";
let cursor: string;
const snapshotRevision = "a".repeat(64);
afterEach(() => vi.unstubAllEnvs());

describe("transaction history action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_SECRET", "synthetic-dashboard-action-cursor-secret");
    cursor = encodeHistoryCursor({ id: "clh1234567890abcdefghijl", scope: "b".repeat(64), filters: "c".repeat(64), revision: snapshotRevision });
    dashboardActionMocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    dashboardActionMocks.enforceUserRateLimit.mockResolvedValue({
      allowed: true,
    });
    dashboardActionMocks.getTransactionHistoryPage.mockResolvedValue({
      transactions: [
        {
          id: "transaction-1",
          amountInCents: 100,
          note: null,
          type: "ADD",
          transactionDate: "2026-07-15",
          createdByName: "Ledger Admin",
        },
      ],
      nextCursor: null,
    });
  });

  it("rejects anonymous history reads before validation, rate-limit, or ledger work", async () => {
    dashboardActionMocks.auth.mockResolvedValue(null);

    await expect(loadMoreTransactionHistory(teamId, cursor, snapshotRevision)).resolves.toEqual({
      status: "error",
      message: "Your session has expired. Please sign in again.",
    });
    expect(dashboardActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(
      dashboardActionMocks.getTransactionHistoryPage,
    ).not.toHaveBeenCalled();
  });

  it("validates identifiers before durable or ledger reads", async () => {
    const result = await loadMoreTransactionHistory("not-a-team", "not-a-cursor", snapshotRevision);

    expect(result).toMatchObject({
      status: "error",
    });
    expect(dashboardActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(
      dashboardActionMocks.getTransactionHistoryPage,
    ).not.toHaveBeenCalled();
  });

  it("returns only the explicit authorized history DTO", async () => {
    const result = await loadMoreTransactionHistory(teamId, cursor, snapshotRevision);

    expect(dashboardActionMocks.enforceUserRateLimit).toHaveBeenCalledWith({
      scope: "transaction-history",
      userId: "user-1",
      limit: 90,
      windowSeconds: 60,
    });
    expect(
      dashboardActionMocks.getTransactionHistoryPage,
    ).toHaveBeenCalledWith("user-1", teamId, cursor, undefined, snapshotRevision, normalizeHistoryFilters({}));
    expect(result).toMatchObject({
      status: "success",
      page: {
        nextCursor: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("email");
    expect(JSON.stringify(result)).not.toContain("userId");
  });

  it("uses the same response for an unknown or cross-team cursor", async () => {
    dashboardActionMocks.getTransactionHistoryPage.mockResolvedValue(null);

    const result = await loadMoreTransactionHistory(teamId, cursor, snapshotRevision);

    expect(result).toEqual({
      status: "error",
      message:
        "This transaction history page is unavailable. Refresh the dashboard and try again.",
    });
  });

  it("rejects a missing or invalid snapshot generation before database work", async () => {
    const result = await loadMoreTransactionHistory(teamId, cursor, "invalid-revision");
    expect(result).toMatchObject({ status: "error" });
    expect(dashboardActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(dashboardActionMocks.getTransactionHistoryPage).not.toHaveBeenCalled();
  });

  it("returns a controlled refresh signal instead of a page from a changed ledger", async () => {
    dashboardActionMocks.getTransactionHistoryPage.mockResolvedValue({ status: "snapshot_changed" });
    const result = await loadMoreTransactionHistory(teamId, cursor, snapshotRevision);
    expect(result).toMatchObject({ status: "error", code: "SNAPSHOT_CHANGED" });
    expect(result).not.toHaveProperty("page");
  });

  it("returns controlled retry information without a ledger read", async () => {
    dashboardActionMocks.enforceUserRateLimit.mockRejectedValue(
      new dashboardActionMocks.RateLimitExceededError(23),
    );

    const result = await loadMoreTransactionHistory(teamId, cursor, snapshotRevision);

    expect(result).toMatchObject({
      status: "error",
      retryAfterSeconds: 23,
    });
    expect(
      dashboardActionMocks.getTransactionHistoryPage,
    ).not.toHaveBeenCalled();
  });

  it("validates discovery filters before quota or data work", async () => {
    await expect(loadFilteredDashboard(teamId, { search: "x".repeat(121) })).resolves.toMatchObject({ status: "error", fieldErrors: { search: expect.any(String) } });
    expect(dashboardActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(dashboardActionMocks.getDashboardData).not.toHaveBeenCalled();
  });

  it("returns an authorized coherent DTO for POST-only note discovery", async () => {
    const data = { teamId, historyFilters: normalizeHistoryFilters({ search: "private receipt" }), matchingSummary: { matchingCount: 30 } };
    dashboardActionMocks.getDashboardData.mockResolvedValueOnce(data);
    await expect(loadFilteredDashboard(teamId, { search: " private receipt " })).resolves.toEqual({ status: "success", data });
    expect(dashboardActionMocks.getDashboardData).toHaveBeenCalledWith("user-1", teamId, expect.objectContaining({ filters: data.historyFilters, now: expect.any(Date) }));
  });

  it("does not let anonymous callers search and returns the same unavailable resource response", async () => {
    dashboardActionMocks.auth.mockResolvedValueOnce(null);
    await expect(loadFilteredDashboard(teamId, {})).resolves.toMatchObject({ status: "error", message: expect.stringContaining("session has expired") });
    expect(dashboardActionMocks.getDashboardData).not.toHaveBeenCalled();
    dashboardActionMocks.getDashboardData.mockResolvedValueOnce(null);
    await expect(loadFilteredDashboard(teamId, {})).resolves.toMatchObject({ status: "error", message: expect.stringContaining("unavailable") });
  });
});
