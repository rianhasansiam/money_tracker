import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getBusinessTodayDateInputValue, parseTransactionDateInput } from "@/lib/date-time";
import { normalizeHistoryFilters } from "@/lib/history-filters";
import {
  POSTGRES_TEST_SKIP_REASON,
  type PostgresTestHarness,
  isPostgresTestDatabaseConfigured,
  openPostgresTestHarness,
} from "../helpers/postgres-test-harness";

const orderBy = [{ transactionDate: "desc" }, { createdAt: "desc" }, { id: "desc" }] as const;

describe("server-backed transaction discovery on disposable PostgreSQL", () => {
  if (!isPostgresTestDatabaseConfigured()) {
    it.skip(POSTGRES_TEST_SKIP_REASON, () => undefined);
    return;
  }
  let harness: PostgresTestHarness;
  let dashboard: typeof import("@/lib/queries/dashboard");
  let transactions: typeof import("@/lib/data/transactions");
  let ownerId: string;
  let teamId: string;
  let rows: Prisma.TransactionCreateManyInput[];
  const now = new Date();
  const today = getBusinessTodayDateInputValue(now);
  const lastMonth = normalizeHistoryFilters({ period: "LAST_MONTH" }, now);

  beforeAll(async () => {
    harness = await openPostgresTestHarness();
    dashboard = await import("@/lib/queries/dashboard");
    transactions = await import("@/lib/data/transactions");
  });
  afterAll(async () => { await harness?.close(); });
  beforeEach(async () => {
    await harness.clean();
    const owner = await harness.db.user.create({ data: { name: "Discovery owner", role: "ADMIN", status: "ACTIVE" } });
    const team = await harness.db.team.create({ data: { name: "Synthetic discovery ledger", createdById: owner.id } });
    ownerId = owner.id;
    teamId = team.id;
    await harness.db.teamMembership.create({ data: { teamId, userId: ownerId, role: "ADMIN", status: "APPROVED", approvedAt: now, approvedById: ownerId } });
    const row = (note: string | null, amountInCents: number, date: string, type: "ADD" | "REMOVE" = "ADD"): Prisma.TransactionCreateManyInput => ({
      teamId, userId: ownerId, actorIdSnapshot: ownerId, actorNameSnapshot: "Discovery owner",
      idempotencyKey: randomUUID(), note, amountInCents, type, transactionDate: parseTransactionDateInput(date),
    });
    rows = [
      row("Opening funding", 1_000_000, "2020-01-01"),
      ...Array.from({ length: 60 }, (_, index) => row(`Receipt invoice ${index + 1}`, (index + 1) * 100, index < 40 ? today : lastMonth.to!, index % 3 === 0 ? "REMOVE" : "ADD")),
      row("Literal 50%_\\ receipt", 15_000, today),
      row("Literal 50XX receipt", 777, today),
      row("ancient literal", 1, "0001-01-01"),
      row("ancient literal", 1, "0099-01-01", "REMOVE"),
      row("ancient literal", 1, "0100-01-01"),
      row(null, 500, today),
    ];
    await harness.db.transaction.createMany({ data: rows });
  });

  it("searches beyond the first page and summarizes every matching row while retaining the whole balance", async () => {
    const filters = normalizeHistoryFilters({ search: " receipt " }, now);
    const first = await dashboard.getDashboardData(ownerId, teamId, { filters, now });
    expect(first).not.toBeNull();
    if (!first) throw new Error("Synthetic discovery fixture was unavailable.");
    const matching = rows.filter((row) => row.note?.toLowerCase().includes("receipt"));
    const added = matching.filter((row) => row.type === "ADD").reduce((sum, row) => sum + row.amountInCents, 0);
    const removed = matching.filter((row) => row.type === "REMOVE").reduce((sum, row) => sum + row.amountInCents, 0);
    const allBalance = rows.reduce((sum, row) => sum + (row.type === "ADD" ? row.amountInCents : -row.amountInCents), 0);
    expect(first.balanceInCents).toBe(allBalance);
    expect(first.matchingSummary).toEqual({ totalAddedInCents: added, totalRemovedInCents: removed, netChangeInCents: added - removed, matchingCount: 62 });
    expect(first.transactionHistory.transactions).toHaveLength(25);
    const expected = await harness.db.transaction.findMany({ where: { teamId, note: { contains: "receipt", mode: "insensitive" } }, orderBy: [...orderBy], select: { id: true } });
    const ids = first.transactionHistory.transactions.map((row) => row.id);
    let cursor = first.transactionHistory.nextCursor;
    while (cursor) {
      const page = await dashboard.getTransactionHistoryPage(ownerId, teamId, cursor, undefined, first.snapshotRevision, filters);
      if (!page || "status" in page) throw new Error("A stable synthetic cursor was rejected.");
      ids.push(...page.transactions.map((row) => row.id));
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(expected.map((row) => row.id));
    expect(new Set(ids).size).toBe(62);
  });

  it("treats percent, underscore, backslash and SQL-looking text as literal note substrings", async () => {
    const literal = await dashboard.getDashboardData(ownerId, teamId, { filters: { search: "50%_\\" } });
    expect(literal?.matchingSummary.matchingCount).toBe(1);
    expect(literal?.transactionHistory.transactions[0]?.note).toBe("Literal 50%_\\ receipt");
    const noInjection = await dashboard.getDashboardData(ownerId, teamId, { filters: { search: "' OR 1=1 --" } });
    expect(noInjection?.matchingSummary.matchingCount).toBe(0);
    expect(noInjection?.ledgerHasTransactions).toBe(true);
    expect(noInjection?.transactionHistory.transactions).toEqual([]);
  });

  it("uses the same inclusive custom/calendar and direction boundaries for rows and totals", async () => {
    const ancient = await dashboard.getDashboardData(ownerId, teamId, { filters: { search: "ancient", period: "CUSTOM", from: "0001-01-01", to: "0099-01-01" } });
    expect(ancient?.matchingSummary).toEqual({ totalAddedInCents: 1, totalRemovedInCents: 1, netChangeInCents: 0, matchingCount: 2 });
    expect(ancient?.transactionHistory.transactions.map((row) => row.transactionDate)).toEqual(["0099-01-01", "0001-01-01"]);
    const previous = await dashboard.getDashboardData(ownerId, teamId, { filters: { search: "receipt", direction: "REMOVE", period: "LAST_MONTH" }, now });
    const matching = rows.filter((row) => row.note?.startsWith("Receipt") && row.type === "REMOVE" && row.transactionDate instanceof Date && row.transactionDate.getTime() === parseTransactionDateInput(lastMonth.to!).getTime());
    const removed = matching.reduce((sum, row) => sum + row.amountInCents, 0);
    expect(previous?.matchingSummary).toEqual({ totalAddedInCents: 0, totalRemovedInCents: removed, netChangeInCents: -removed, matchingCount: matching.length });
    expect(previous?.transactionHistory.transactions).toHaveLength(matching.length);
    expect(previous?.historyFilters).toMatchObject({ from: lastMonth.from, to: lastMonth.to });
  });

  it("rejects valid signed cursors from other viewers, teams, filters and changed snapshots", async () => {
    const first = await dashboard.getDashboardData(ownerId, teamId, { filters: { search: "receipt" } });
    if (!first?.transactionHistory.nextCursor) throw new Error("Synthetic discovery did not create a cursor.");
    const outsider = await harness.db.user.create({ data: { name: "Unjoined global admin", role: "ADMIN", status: "ACTIVE" } });
    await expect(dashboard.getDashboardData(outsider.id, teamId, { filters: { search: "receipt" } })).resolves.toBeNull();
    await expect(dashboard.getTransactionHistoryPage(outsider.id, teamId, first.transactionHistory.nextCursor, undefined, first.snapshotRevision, { search: "receipt" })).resolves.toBeNull();
    await expect(dashboard.getTransactionHistoryPage(ownerId, "not-this-team", first.transactionHistory.nextCursor, undefined, first.snapshotRevision, { search: "receipt" })).resolves.toBeNull();
    await expect(dashboard.getTransactionHistoryPage(ownerId, teamId, first.transactionHistory.nextCursor, undefined, first.snapshotRevision, { search: "literal" })).resolves.toEqual({ status: "snapshot_changed" });
    await transactions.createTeamTransaction(ownerId, { teamId, idempotencyKey: randomUUID(), amountInCents: 100, note: "A backdated unmatched write", type: "ADD", transactionDate: parseTransactionDateInput("2020-01-01") });
    await expect(dashboard.getTransactionHistoryPage(ownerId, teamId, first.transactionHistory.nextCursor, undefined, first.snapshotRevision, { search: "receipt" })).resolves.toEqual({ status: "snapshot_changed" });
  });

  it("checks active accounts and team membership independently of global roles", async () => {
    const member = await harness.db.user.create({ data: { name: "Global moderator team member", role: "MODERATOR", status: "ACTIVE" } });
    await harness.db.teamMembership.create({ data: { teamId, userId: member.id, status: "APPROVED", approvedAt: now, approvedById: ownerId } });
    expect((await dashboard.getDashboardData(member.id, teamId, { filters: { search: "receipt" } }))?.canManageTransactions).toBe(false);
    await expect(transactions.createTeamTransaction(member.id, { teamId, idempotencyKey: randomUUID(), amountInCents: 100, note: "Unauthorized", type: "ADD", transactionDate: parseTransactionDateInput(today) })).rejects.toBeInstanceOf(transactions.UnauthorizedTransactionError);
    await harness.db.user.update({ where: { id: member.id }, data: { status: "DISABLED", disabledAt: now } });
    await expect(dashboard.getDashboardData(member.id, teamId, { filters: { search: "receipt" } })).resolves.toBeNull();
    await harness.db.team.update({ where: { id: teamId }, data: { deletedAt: now, purgeAfter: new Date(now.getTime() + 30 * 86_400_000), deletedById: ownerId } });
    await expect(dashboard.getDashboardData(ownerId, teamId, { filters: { search: "receipt" } })).resolves.toBeNull();
  });

  it("keeps aggregates and filtered rows on the same snapshot during a concurrent write", async () => {
    const before = await dashboard.getDashboardData(ownerId, teamId, { filters: { search: "receipt" } });
    const consistent = await dashboard.getDashboardData(ownerId, teamId, {
      filters: { search: "receipt" },
      afterAggregate: async () => { await transactions.createTeamTransaction(ownerId, { teamId, idempotencyKey: randomUUID(), amountInCents: 123, note: "New receipt", type: "ADD", transactionDate: parseTransactionDateInput(today) }); },
    });
    expect(consistent?.matchingSummary).toEqual(before?.matchingSummary);
    expect(consistent?.transactionHistory).toEqual(before?.transactionHistory);
    const after = await dashboard.getDashboardData(ownerId, teamId, { filters: { search: "receipt" } });
    expect(after?.matchingSummary.matchingCount).toBe(63);
    expect(after?.snapshotRevision).not.toBe(before?.snapshotRevision);
  });

  it("records representative team-scoped index plans without adding speculative schema changes", async () => {
    const otherTeam = await harness.db.team.create({ data: { name: "Unrelated scale ledger", createdById: ownerId } });
    await harness.db.transaction.createMany({ data: Array.from({ length: 3_000 }, (_, index) => ({ teamId: otherTeam.id, userId: ownerId, idempotencyKey: randomUUID(), actorIdSnapshot: ownerId, actorNameSnapshot: "Discovery owner", type: "ADD", amountInCents: 1, note: `Unrelated ${index}`, transactionDate: parseTransactionDateInput(today) })) });
    await harness.db.$executeRaw`ANALYZE "Transaction"`;
    const history = await harness.db.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "id" FROM "Transaction" WHERE "teamId" = ${teamId}
        AND "note" ILIKE ${"%receipt%"} AND "type" = 'ADD'
        AND "transactionDate" >= ${parseTransactionDateInput(lastMonth.from!)}
      ORDER BY "transactionDate" DESC, "createdAt" DESC, "id" DESC LIMIT 26`);
    const aggregate = await harness.db.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "type", SUM("amountInCents"), COUNT(*) FROM "Transaction"
      WHERE "teamId" = ${teamId} AND "note" ILIKE ${"%receipt%"} GROUP BY "type"`);
    const plans = { fixtureRows: 3_067, targetTeamRows: 67, history, aggregate };
    expect(JSON.stringify(history)).toContain("Index");
    expect(JSON.stringify(aggregate)).toContain("Index");
    if (process.env.HISTORY_QUERY_PLAN_OUTPUT) await writeFile(process.env.HISTORY_QUERY_PLAN_OUTPUT, JSON.stringify(plans, null, 2));
  });
});
