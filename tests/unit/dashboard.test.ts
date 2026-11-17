import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyAggregateOverflowError } from "@/lib/money";
import { decodeHistoryCursor } from "@/lib/history-cursor";
import { InvalidHistoryFiltersError } from "@/lib/history-filters";

afterEach(() => vi.unstubAllEnvs());

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
    id: `c${String(index).padStart(24, "0")}`,
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
    vi.stubEnv("AUTH_SECRET", "synthetic-dashboard-cursor-unit-secret");
    dashboardMocks.membershipFindUnique.mockResolvedValue({
      role: "ADMIN",
      status: "APPROVED",
      user: { status: "ACTIVE", disabledAt: null, deletedAt: null },
      team: {
        id: "team-1",
        name: "Operations",
        description: "Shared costs",
        deletedAt: null,
      },
    });
    dashboardMocks.transactionGroupBy.mockResolvedValue([
      { type: "ADD", _sum: { amountInCents: 10_000 }, _count: { _all: 1 } },
      { type: "REMOVE", _sum: { amountInCents: 2_500 }, _count: { _all: 1 } },
    ]);
    dashboardMocks.transactionFindFirst.mockResolvedValue({ id: transactionRow(24).id });
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
    expect(serialized).not.toContain("user-1");
    expect(findManyInput).not.toEqual(
      expect.objectContaining({
        select: expect.objectContaining({
          createdBy: expect.anything(),
        }),
      }),
    );
  });

  it("uses stable viewer/team scopes and revisions rather than resetting on unrelated renders", async () => {
    const first = await getDashboardData("user-1", "team-1");
    const same = await getDashboardData("user-1", "team-1");
    const otherViewer = await getDashboardData("user-2", "team-1");
    const otherTeam = await getDashboardData("user-1", "team-2");

    expect(first?.snapshotScope).toMatch(/^[a-f0-9]{64}$/);
    expect(same?.snapshotScope).toBe(first?.snapshotScope);
    expect(same?.snapshotRevision).toBe(first?.snapshotRevision);
    expect(otherViewer?.snapshotScope).not.toBe(first?.snapshotScope);
    expect(otherViewer?.snapshotRevision).not.toBe(first?.snapshotRevision);
    expect(otherTeam?.snapshotScope).not.toBe(first?.snapshotScope);
  });

  it("invalidates pagination for backdated writes even when the first page and net balance are unchanged", async () => {
    const first = await getDashboardData("user-1", "team-1");
    dashboardMocks.transactionGroupBy.mockResolvedValue([
      { type: "ADD", _sum: { amountInCents: 10_100 }, _count: { _all: 2 } },
      { type: "REMOVE", _sum: { amountInCents: 2_600 }, _count: { _all: 2 } },
    ]);
    const changed = await getDashboardData("user-1", "team-1");

    expect(changed?.balanceInCents).toBe(first?.balanceInCents);
    expect(changed?.transactionHistory).toEqual(first?.transactionHistory);
    expect(changed?.snapshotScope).toBe(first?.snapshotScope);
    expect(changed?.snapshotRevision).not.toBe(first?.snapshotRevision);
  });

  it("invalidates the revision when the authoritative first-page ordering changes", async () => {
    const first = await getDashboardData("user-1", "team-1");
    dashboardMocks.transactionFindMany.mockResolvedValue([transactionRow(1)]);
    const changed = await getDashboardData("user-1", "team-1");
    expect(changed?.snapshotRevision).not.toBe(first?.snapshotRevision);
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
    const initial = await getDashboardData("user-1", "team-1");
    dashboardMocks.transactionFindMany.mockClear();

    const result = await getTransactionHistoryPage(
      "user-1",
      "team-1",
      initial!.transactionHistory.nextCursor!,
      100_000,
    );

    expect(dashboardMocks.transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId: "team-1" },
        cursor: { id: transactionRow(24).id },
        skip: 1,
        take: TRANSACTION_HISTORY_MAX_PAGE_SIZE + 1,
      }),
    );
    expect(result?.transactions).toHaveLength(
      TRANSACTION_HISTORY_MAX_PAGE_SIZE,
    );
    expect(decodeHistoryCursor(result!.nextCursor!)?.id).toBe(transactionRow(TRANSACTION_HISTORY_MAX_PAGE_SIZE - 1).id);
  });

  it("rejects an unknown or cross-team cursor before reading a page", async () => {
    dashboardMocks.transactionFindMany.mockResolvedValue(Array.from({ length: 26 }, (_, index) => transactionRow(index)));
    const initial = await getDashboardData("user-1", "team-1");
    dashboardMocks.transactionFindMany.mockClear();
    dashboardMocks.transactionFindFirst.mockResolvedValue(null);

    const result = await getTransactionHistoryPage(
      "user-1",
      "team-1",
      initial!.transactionHistory.nextCursor!,
    );

    expect(result).toBeNull();
    expect(dashboardMocks.transactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: transactionRow(24).id,
          teamId: "team-1",
        },
      }),
    );
    expect(dashboardMocks.transactionFindMany).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: expect.anything() }));
  });

  it("rejects incremental reads after an external backdated write changes the authoritative totals", async () => {
    dashboardMocks.transactionFindMany.mockResolvedValue(Array.from({ length: 26 }, (_, index) => transactionRow(index)));
    const initial = await getDashboardData("user-1", "team-1");
    dashboardMocks.transactionGroupBy.mockResolvedValue([
      { type: "ADD", _sum: { amountInCents: 10_100 }, _count: { _all: 2 } },
      { type: "REMOVE", _sum: { amountInCents: 2_500 }, _count: { _all: 1 } },
    ]);
    dashboardMocks.transactionFindMany.mockClear();

    const page = await getTransactionHistoryPage("user-1", "team-1", initial!.transactionHistory.nextCursor!, undefined, initial!.snapshotRevision);
    expect(page).toEqual({ status: "snapshot_changed" });
    // Only the bounded current first page is read for revision validation;
    // no rows after the old cursor can enter the stale client generation.
    expect(dashboardMocks.transactionFindMany).toHaveBeenCalledTimes(1);
    expect(dashboardMocks.transactionFindMany).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: expect.anything() }));
    expect(dashboardMocks.runTransaction.mock.calls.at(-1)?.[1]).toEqual({ isolationLevel: "RepeatableRead" });
  });

  it("reads the next page when viewer, totals and first-page generation still match", async () => {
    dashboardMocks.transactionFindMany.mockResolvedValue(Array.from({ length: 26 }, (_, index) => transactionRow(index)));
    const initial = await getDashboardData("user-1", "team-1");
    dashboardMocks.transactionFindMany.mockClear();
    const page = await getTransactionHistoryPage("user-1", "team-1", initial!.transactionHistory.nextCursor!, undefined, initial!.snapshotRevision);
    expect(page).toMatchObject({ transactions: expect.arrayContaining([expect.objectContaining({ id: transactionRow(0).id })]) });
    expect(dashboardMocks.transactionFindMany).toHaveBeenCalledTimes(2);
    expect(dashboardMocks.transactionFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { id: transactionRow(24).id } }));
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

  it("uses exactly the filtered predicate for matching aggregates and bounded history", async () => {
    dashboardMocks.transactionGroupBy.mockResolvedValueOnce([
      { type: "ADD", _sum: { amountInCents: 10_000 }, _count: { _all: 40 } },
      { type: "REMOVE", _sum: { amountInCents: 2_500 }, _count: { _all: 30 } },
    ]).mockResolvedValueOnce([
      { type: "REMOVE", _sum: { amountInCents: 2_000 }, _count: { _all: 28 } },
    ]);
    const result = await getDashboardData("user-1", "team-1", {
      filters: { search: "50%_\\receipt", direction: "REMOVE", period: "CUSTOM", from: "0001-01-01", to: "2026-07-15" },
    });
    const matchingQuery = dashboardMocks.transactionGroupBy.mock.calls[1][0] as { where: unknown };
    expect(matchingQuery.where).toEqual({
      teamId: "team-1", type: "REMOVE", note: { contains: "50\\%\\_\\\\receipt", mode: "insensitive" },
      transactionDate: { gte: new Date("0001-01-01T00:00:00.000Z"), lte: new Date("2026-07-15T00:00:00.000Z") },
    });
    expect(dashboardMocks.transactionFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: matchingQuery.where, take: 26 }));
    expect(result).toMatchObject({
      balanceInCents: 7_500, totalAddedInCents: 10_000, totalRemovedInCents: 2_500,
      ledgerHasTransactions: true,
      matchingSummary: { totalAddedInCents: 0, totalRemovedInCents: 2_000, netChangeInCents: -2_000, matchingCount: 28 },
    });
  });

  it.each(["PENDING", "DISABLED", "DELETED"])("rejects %s accounts beside the data read", async (status) => {
    dashboardMocks.membershipFindUnique.mockResolvedValue({
      role: "ADMIN", status: "APPROVED", user: { status, disabledAt: null, deletedAt: null },
      team: { id: "team-1", name: "Operations", deletedAt: null },
    });
    await expect(getDashboardData("user-1", "team-1", { filters: { search: "receipt" } })).resolves.toBeNull();
    expect(dashboardMocks.transactionGroupBy).not.toHaveBeenCalled();
    expect(dashboardMocks.transactionFindMany).not.toHaveBeenCalled();
  });

  it("rejects invalid filters before starting a database read", async () => {
    await expect(getDashboardData("user-1", "team-1", { filters: { direction: "BAD" } })).rejects.toBeInstanceOf(InvalidHistoryFiltersError);
    expect(dashboardMocks.runTransaction).not.toHaveBeenCalled();
  });

  it("identifies a truly empty ledger independently of a zero monetary balance", async () => {
    dashboardMocks.transactionGroupBy.mockResolvedValue([]);
    dashboardMocks.transactionFindMany.mockResolvedValue([]);
    await expect(getDashboardData("user-1", "team-1")).resolves.toMatchObject({
      ledgerHasTransactions: false,
      balanceInCents: 0,
      matchingSummary: { matchingCount: 0, totalAddedInCents: 0, totalRemovedInCents: 0, netChangeInCents: 0 },
      transactionHistory: { transactions: [], nextCursor: null },
    });
    dashboardMocks.transactionGroupBy.mockResolvedValue([
      { type: "ADD", _sum: { amountInCents: 100 }, _count: { _all: 1 } },
      { type: "REMOVE", _sum: { amountInCents: 100 }, _count: { _all: 1 } },
    ]);
    expect((await getDashboardData("user-1", "team-1"))?.ledgerHasTransactions).toBe(true);
  });

  it("rejects unsafe matching counts as well as unsafe monetary aggregates", async () => {
    dashboardMocks.transactionGroupBy.mockResolvedValue([
      { type: "ADD", _sum: { amountInCents: 100 }, _count: { _all: Number.MAX_SAFE_INTEGER + 1 } },
    ]);
    await expect(getDashboardData("user-1", "team-1")).rejects.toBeInstanceOf(MoneyAggregateOverflowError);
  });

  it("binds valid cursors to their viewer, team, filter and revision", async () => {
    dashboardMocks.transactionFindMany.mockResolvedValue(Array.from({ length: 26 }, (_, index) => transactionRow(index)));
    const first = await getDashboardData("user-1", "team-1");
    const cursor = first!.transactionHistory.nextCursor!;
    const callsBefore = dashboardMocks.runTransaction.mock.calls.length;
    await expect(getTransactionHistoryPage("other-user", "team-1", cursor)).resolves.toBeNull();
    await expect(getTransactionHistoryPage("user-1", "other-team", cursor)).resolves.toBeNull();
    expect(dashboardMocks.runTransaction.mock.calls.length).toBe(callsBefore);
    await expect(getTransactionHistoryPage("user-1", "team-1", cursor, undefined, first!.snapshotRevision, { search: "different" })).resolves.toEqual({ status: "snapshot_changed" });
    expect(dashboardMocks.transactionFindMany).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: expect.anything() }));
  });
});
