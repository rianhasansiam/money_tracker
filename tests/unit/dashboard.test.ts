import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyAggregateOverflowError } from "@/lib/money";

const dashboardMocks = vi.hoisted(() => {
  const membershipFindUnique = vi.fn<(input: unknown) => Promise<unknown>>();
  const transactionGroupBy = vi.fn<(input: unknown) => Promise<unknown>>();
  const transactionFindFirst = vi.fn<(input: unknown) => Promise<unknown>>();
  const transactionFindMany = vi.fn<(input: unknown) => Promise<unknown>>();
  const transactionClient = {
    teamMembership: {
      findUnique: membershipFindUnique,
    },
    transaction: {
      groupBy: transactionGroupBy,
      findFirst: transactionFindFirst,
      findMany: transactionFindMany,
    },
  };
  const runTransaction = vi.fn(
    async (
      callback: (client: typeof transactionClient) => Promise<unknown>,
      options?: { isolationLevel?: string },
    ) => {
      void options;
      return callback(transactionClient);
    },
  );

  return {
    membershipFindUnique,
    runTransaction,
    transactionFindFirst,
    transactionFindMany,
    transactionGroupBy,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: dashboardMocks.runTransaction,
  },
}));

import {
  TRANSACTION_HISTORY_MAX_PAGE_SIZE,
  TRANSACTION_HISTORY_PAGE_SIZE,
  getDashboardData,
  getTransactionHistoryPage,
} from "@/lib/queries/dashboard";

function transactionRow(index: number) {
  return {
    id: `transaction-${String(index).padStart(3, "0")}`,
    amountInCents: 10_000 + index,
    note: index === 0 ? "Opening balance" : null,
    type: "ADD",
    transactionDate: new Date("2026-07-15T00:00:00.000Z"),
    actorNameSnapshot: "Ledger Admin",
  };
}

describe("dashboard DTO and pagination queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardMocks.membershipFindUnique.mockResolvedValue({
      role: "ADMIN",
      status: "APPROVED",
      team: {
        id: "team-1",
        name: "Operations",
        description: "Shared costs",
        deletedAt: null,
      },
    });
    dashboardMocks.transactionGroupBy.mockResolvedValue([
      { type: "ADD", _sum: { amountInCents: 10_000 } },
      { type: "REMOVE", _sum: { amountInCents: 2_500 } },
    ]);
    dashboardMocks.transactionFindFirst.mockResolvedValue({ id: "cursor-1" });
    dashboardMocks.transactionFindMany.mockResolvedValue([transactionRow(0)]);
  });

  it("reads authorization, totals, and only the first bounded page through one snapshot", async () => {
    const afterAggregate = vi.fn(async () => undefined);
    const result = await getDashboardData("user-1", "team-1", {
      afterAggregate,
    });

    expect(dashboardMocks.runTransaction).toHaveBeenCalledTimes(1);
    expect(dashboardMocks.runTransaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: "RepeatableRead",
    });
    expect(dashboardMocks.transactionGroupBy).toHaveBeenCalledTimes(1);
    expect(afterAggregate).toHaveBeenCalledTimes(1);
    expect(
      dashboardMocks.transactionGroupBy.mock.invocationCallOrder[0],
    ).toBeLessThan(afterAggregate.mock.invocationCallOrder[0] ?? 0);
    expect(afterAggregate.mock.invocationCallOrder[0]).toBeLessThan(
      dashboardMocks.transactionFindMany.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result).toMatchObject({
      balanceInCents: 7_500,
      totalAddedInCents: 10_000,
      totalRemovedInCents: 2_500,
      transactionHistory: {
        nextCursor: null,
        transactions: [
          {
            transactionDate: "2026-07-15",
            createdByName: "Ledger Admin",
          },
        ],
      },
    });

    const findManyInput = dashboardMocks.transactionFindMany.mock.calls[0]?.[0];
    expect(findManyInput).toEqual(
      expect.objectContaining({
        take: TRANSACTION_HISTORY_PAGE_SIZE + 1,
        orderBy: [
          { transactionDate: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        select: expect.objectContaining({
          actorNameSnapshot: true,
        }),
      }),
    );
  });

  it("returns an explicit privacy-safe DTO without account or live-user fields", async () => {
    const result = await getDashboardData("user-1", "team-1");
    const serialized = JSON.stringify(result);
    const findManyInput = dashboardMocks.transactionFindMany.mock.calls[0]?.[0];

    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("session");
    expect(serialized).not.toContain("oauth");
    expect(findManyInput).not.toEqual(
      expect.objectContaining({
        select: expect.objectContaining({
          createdBy: expect.anything(),
        }),
      }),
    );
  });

  it("does not read ledger data when membership is pending or the team is quarantined", async () => {
    dashboardMocks.membershipFindUnique.mockResolvedValueOnce({
      role: "MEMBER",
      status: "PENDING",
      team: {
        id: "team-1",
        name: "Operations",
        description: null,
        deletedAt: null,
      },
    });

    await expect(getDashboardData("user-1", "team-1")).resolves.toBeNull();

    dashboardMocks.membershipFindUnique.mockResolvedValueOnce({
      role: "ADMIN",
      status: "APPROVED",
      team: {
        id: "team-1",
        name: "Operations",
        description: null,
        deletedAt: new Date(),
      },
    });

    await expect(getDashboardData("user-1", "team-1")).resolves.toBeNull();
    expect(dashboardMocks.transactionGroupBy).not.toHaveBeenCalled();
    expect(dashboardMocks.transactionFindMany).not.toHaveBeenCalled();
  });

  it("enforces the hard page-size maximum and emits only an authorized-page cursor", async () => {
    const rows = Array.from(
      { length: TRANSACTION_HISTORY_MAX_PAGE_SIZE + 1 },
      (_, index) => transactionRow(index),
    );
    dashboardMocks.transactionFindMany.mockResolvedValue(rows);

    const result = await getTransactionHistoryPage(
      "user-1",
      "team-1",
      "cursor-1",
      100_000,
    );

    expect(dashboardMocks.transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId: "team-1" },
        cursor: { id: "cursor-1" },
        skip: 1,
        take: TRANSACTION_HISTORY_MAX_PAGE_SIZE + 1,
      }),
    );
    expect(result?.transactions).toHaveLength(
      TRANSACTION_HISTORY_MAX_PAGE_SIZE,
    );
    expect(result?.nextCursor).toBe(
      `transaction-${String(
        TRANSACTION_HISTORY_MAX_PAGE_SIZE - 1,
      ).padStart(3, "0")}`,
    );
  });

  it("rejects an unknown or cross-team cursor before reading a page", async () => {
    dashboardMocks.transactionFindFirst.mockResolvedValue(null);

    const result = await getTransactionHistoryPage(
      "user-1",
      "team-1",
      "cursor-from-another-team",
    );

    expect(result).toBeNull();
    expect(dashboardMocks.transactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "cursor-from-another-team",
          teamId: "team-1",
        },
      }),
    );
    expect(dashboardMocks.transactionFindMany).not.toHaveBeenCalled();
  });

  it("rejects unsafe aggregate values", async () => {
    dashboardMocks.transactionGroupBy.mockResolvedValue([
      {
        type: "ADD",
        _sum: { amountInCents: Number.MAX_SAFE_INTEGER + 1 },
      },
    ]);
    dashboardMocks.transactionFindMany.mockResolvedValue([]);

    await expect(getDashboardData("user-1", "team-1")).rejects.toBeInstanceOf(
      MoneyAggregateOverflowError,
    );
  });
});
