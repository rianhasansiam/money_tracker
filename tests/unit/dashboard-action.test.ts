import { beforeEach, describe, expect, it, vi } from "vitest";

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
    getTransactionHistoryPage: vi.fn<(userId: string, teamId: string, cursor: string) => Promise<unknown>>(),
    RateLimitExceededError,
    RateLimitUnavailableError,
  };
});

vi.mock("@/lib/auth", () => ({
  auth: dashboardActionMocks.auth,
}));

vi.mock("@/lib/queries/dashboard", () => ({
  getTransactionHistoryPage: dashboardActionMocks.getTransactionHistoryPage,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: dashboardActionMocks.enforceUserRateLimit,
  RateLimitExceededError: dashboardActionMocks.RateLimitExceededError,
  RateLimitUnavailableError: dashboardActionMocks.RateLimitUnavailableError,
}));

import { loadMoreTransactionHistory } from "@/actions/dashboard";

const teamId = "clh1234567890abcdefghijk";
const cursor = "clh1234567890abcdefghijl";

describe("transaction history action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    await expect(loadMoreTransactionHistory(teamId, cursor)).resolves.toEqual({
      status: "error",
      message: "Your session has expired. Please sign in again.",
    });
    expect(dashboardActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(
      dashboardActionMocks.getTransactionHistoryPage,
    ).not.toHaveBeenCalled();
  });

  it("validates identifiers before durable or ledger reads", async () => {
    const result = await loadMoreTransactionHistory("not-a-team", "not-a-cursor");

    expect(result).toMatchObject({
      status: "error",
    });
    expect(dashboardActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(
      dashboardActionMocks.getTransactionHistoryPage,
    ).not.toHaveBeenCalled();
  });

  it("returns only the explicit authorized history DTO", async () => {
    const result = await loadMoreTransactionHistory(teamId, cursor);

    expect(dashboardActionMocks.enforceUserRateLimit).toHaveBeenCalledWith({
      scope: "transaction-history",
      userId: "user-1",
      limit: 90,
      windowSeconds: 60,
    });
    expect(
      dashboardActionMocks.getTransactionHistoryPage,
    ).toHaveBeenCalledWith("user-1", teamId, cursor);
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

    const result = await loadMoreTransactionHistory(teamId, cursor);

    expect(result).toEqual({
      status: "error",
      message:
        "This transaction history page is unavailable. Refresh the dashboard and try again.",
    });
  });

  it("returns controlled retry information without a ledger read", async () => {
    dashboardActionMocks.enforceUserRateLimit.mockRejectedValue(
      new dashboardActionMocks.RateLimitExceededError(23),
    );

    const result = await loadMoreTransactionHistory(teamId, cursor);

    expect(result).toMatchObject({
      status: "error",
      retryAfterSeconds: 23,
    });
    expect(
      dashboardActionMocks.getTransactionHistoryPage,
    ).not.toHaveBeenCalled();
  });
});
