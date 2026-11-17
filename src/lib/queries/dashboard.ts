import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { parseTransactionDateInput, toTransactionDateInputValue } from "@/lib/date-time";
import { decodeHistoryCursor, encodeHistoryCursor } from "@/lib/history-cursor";
import { hasHistoryFilters, normalizeHistoryFilters, type HistoryFilters } from "@/lib/history-filters";
import { calculateBalanceInCents, MoneyAggregateOverflowError } from "@/lib/money";
import type { TeamMembershipRoleValue } from "@/lib/queries/groups";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { canManageTeamMembership } from "@/lib/roles";

export const TRANSACTION_HISTORY_PAGE_SIZE = 25;
export const TRANSACTION_HISTORY_MAX_PAGE_SIZE = 50;
export type DashboardTransactionType = "ADD" | "REMOVE";

/** Minimal, authorized ledger projection; no live-account or credential data. */
export interface DashboardTransactionDto {
  id: string;
  amountInCents: number;
  note: string | null;
  type: DashboardTransactionType;
  transactionDate: string;
  createdByName: string;
}

export interface TransactionHistoryPageDto {
  transactions: DashboardTransactionDto[];
  nextCursor: string | null;
}

export interface MatchingTransactionSummary {
  totalAddedInCents: number;
  totalRemovedInCents: number;
  netChangeInCents: number;
  matchingCount: number;
}

export interface DashboardDataDto {
  /** Actor/team lifecycle scope; filters must not discard a financial draft. */
  snapshotScope: string;
  /** Includes normalized filters and authoritative totals, not just visible rows. */
  snapshotRevision: string;
  teamId: string;
  teamName: string;
  viewerRole: TeamMembershipRoleValue;
  canManageTransactions: boolean;
  balanceInCents: number;
  totalAddedInCents: number;
  totalRemovedInCents: number;
  transactionHistory: TransactionHistoryPageDto;
  historyFilters: HistoryFilters;
  matchingSummary: MatchingTransactionSummary;
  ledgerHasTransactions: boolean;
  refreshedAt: string;
}

export type DashboardTransaction = DashboardTransactionDto;
export type DashboardData = DashboardDataDto;

interface DashboardReadOptions {
  filters?: unknown;
  /** Internal clock/barrier seams; never copied from a request. */
  now?: Date;
  afterAggregate?: () => Promise<void>;
}

type TransactionProjection = {
  id: string;
  amountInCents: number;
  note: string | null;
  type: string;
  transactionDate: Date;
  actorNameSnapshot: string;
};
type AggregateRow = {
  type: DashboardTransactionType;
  _sum: { amountInCents: number | null };
  _count: { _all: number };
};

const membershipSelect = {
  role: true,
  status: true,
  user: { select: { status: true, disabledAt: true, deletedAt: true } },
  team: { select: { id: true, name: true, deletedAt: true } },
} as const;
const transactionHistoryOrder = [
  { transactionDate: "desc" as const },
  { createdAt: "desc" as const },
  { id: "desc" as const },
];
const transactionHistorySelect = {
  id: true,
  amountInCents: true,
  note: true,
  type: true,
  transactionDate: true,
  actorNameSnapshot: true,
} as const;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedPageSize(requested: number) {
  return Number.isFinite(requested)
    ? Math.min(TRANSACTION_HISTORY_MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)))
    : TRANSACTION_HISTORY_PAGE_SIZE;
}

/** All user text remains a bound Prisma parameter. Escape LIKE metacharacters. */
function historyWhere(teamId: string, filters: HistoryFilters): Prisma.TransactionWhereInput {
  return {
    teamId,
    ...(filters.direction !== "ALL" ? { type: filters.direction } : {}),
    ...(filters.search ? {
      note: { contains: filters.search.replace(/[\\%_]/g, "\\$&"), mode: "insensitive" },
    } : {}),
    ...(filters.from || filters.to ? { transactionDate: {
      ...(filters.from ? { gte: parseTransactionDateInput(filters.from) } : {}),
      ...(filters.to ? { lte: parseTransactionDateInput(filters.to) } : {}),
    } } : {}),
  };
}

async function authorizedMembership(tx: Prisma.TransactionClient, userId: string, teamId: string) {
  const membership = await tx.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: membershipSelect,
  });
  if (!membership || membership.status !== "APPROVED" || membership.team.deletedAt !== null ||
      membership.user.status !== "ACTIVE" || membership.user.disabledAt !== null || membership.user.deletedAt !== null) {
    return null;
  }
  return membership;
}

function summarize(rows: AggregateRow[]): MatchingTransactionSummary {
  const totals = rows.map((entry) => ({ type: entry.type, amountInCents: entry._sum.amountInCents ?? 0 }));
  const netChangeInCents = calculateBalanceInCents(totals);
  let matchingCount = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row._count._all) || row._count._all < 0) throw new MoneyAggregateOverflowError();
    matchingCount += row._count._all;
    if (!Number.isSafeInteger(matchingCount)) throw new MoneyAggregateOverflowError();
  }
  return {
    totalAddedInCents: totals.find((entry) => entry.type === "ADD")?.amountInCents ?? 0,
    totalRemovedInCents: totals.find((entry) => entry.type === "REMOVE")?.amountInCents ?? 0,
    netChangeInCents,
    matchingCount,
  };
}

function toTransactions(rows: TransactionProjection[]): DashboardTransactionDto[] {
  return rows.map((row) => ({
    id: row.id,
    amountInCents: row.amountInCents,
    note: row.note,
    type: row.type as DashboardTransactionType,
    transactionDate: toTransactionDateInputValue(row.transactionDate),
    createdByName: row.actorNameSnapshot,
  }));
}

function toPage(
  rows: TransactionProjection[],
  pageSize: number,
  cursorScope: { scope: string; filters: string; revision: string },
): TransactionHistoryPageDto {
  const hasNextPage = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  return {
    transactions: toTransactions(pageRows),
    nextCursor: hasNextPage && pageRows.length
      ? encodeHistoryCursor({ id: pageRows[pageRows.length - 1].id, ...cursorScope })
      : null,
  };
}

async function readSnapshot(
  tx: Prisma.TransactionClient,
  userId: string,
  teamId: string,
  filters: HistoryFilters,
  afterAggregate?: () => Promise<void>,
) {
  const where = historyWhere(teamId, filters);
  const allRows = await tx.transaction.groupBy({
    by: ["type"], where: { teamId }, _sum: { amountInCents: true }, _count: { _all: true },
  });
  const matchingRows = hasHistoryFilters(filters) ? await tx.transaction.groupBy({
    by: ["type"], where, _sum: { amountInCents: true }, _count: { _all: true },
  }) : allRows;
  const allTime = summarize(allRows);
  const matchingSummary = summarize(matchingRows);
  await afterAggregate?.();
  const rows = await tx.transaction.findMany({
    where, orderBy: transactionHistoryOrder, take: TRANSACTION_HISTORY_PAGE_SIZE + 1, select: transactionHistorySelect,
  });
  const scope = hash([userId, teamId]);
  const filterSignature = hash(filters);
  const revision = hash([
    scope, filterSignature, allTime, matchingSummary,
    rows.slice(0, TRANSACTION_HISTORY_PAGE_SIZE).map((row) => row.id),
    rows.length > TRANSACTION_HISTORY_PAGE_SIZE,
  ]);
  const cursorScope = { scope, filters: filterSignature, revision };
  return {
    allTime,
    matchingSummary,
    cursorScope,
    where,
    transactionHistory: toPage(rows, TRANSACTION_HISTORY_PAGE_SIZE, cursorScope),
  };
}

export async function getDashboardData(
  userId: string,
  teamId: string,
  options: DashboardReadOptions = {},
): Promise<DashboardDataDto | null> {
  const filters = normalizeHistoryFilters(options.filters ?? {}, options.now);
  return db.$transaction(async (tx) => {
    const membership = await authorizedMembership(tx, userId, teamId);
    if (!membership) return null;
    const snapshot = await readSnapshot(tx, userId, teamId, filters, options.afterAggregate);
    return {
      snapshotScope: snapshot.cursorScope.scope,
      snapshotRevision: snapshot.cursorScope.revision,
      teamId: membership.team.id,
      teamName: membership.team.name,
      viewerRole: membership.role as TeamMembershipRoleValue,
      canManageTransactions: canManageTeamMembership(membership.role),
      balanceInCents: snapshot.allTime.netChangeInCents,
      totalAddedInCents: snapshot.allTime.totalAddedInCents,
      totalRemovedInCents: snapshot.allTime.totalRemovedInCents,
      transactionHistory: snapshot.transactionHistory,
      historyFilters: filters,
      matchingSummary: snapshot.matchingSummary,
      ledgerHasTransactions: snapshot.allTime.matchingCount > 0,
      refreshedAt: new Date().toISOString(),
    };
  }, { isolationLevel: "RepeatableRead" });
}

export async function getRateLimitedDashboardData(userId: string, teamId: string, input: unknown = {}) {
  const now = new Date();
  const filters = normalizeHistoryFilters(input, now);
  await enforceUserRateLimit({ scope: "transaction-history", userId, limit: 90, windowSeconds: 60 });
  return getDashboardData(userId, teamId, { filters, now });
}

interface ChangedTransactionSnapshot { status: "snapshot_changed" }
export function getTransactionHistoryPage(
  userId: string, teamId: string, cursor: string, requestedPageSize?: number,
): Promise<TransactionHistoryPageDto | null>;
export function getTransactionHistoryPage(
  userId: string, teamId: string, cursor: string, requestedPageSize: number | undefined,
  expectedSnapshotRevision: string, filters?: unknown,
): Promise<TransactionHistoryPageDto | ChangedTransactionSnapshot | null>;
export async function getTransactionHistoryPage(
  userId: string,
  teamId: string,
  cursor: string,
  requestedPageSize = TRANSACTION_HISTORY_PAGE_SIZE,
  expectedSnapshotRevision?: string,
  input: unknown = {},
): Promise<TransactionHistoryPageDto | ChangedTransactionSnapshot | null> {
  const filters = normalizeHistoryFilters(input);
  const payload = decodeHistoryCursor(cursor);
  if (!payload || payload.scope !== hash([userId, teamId]) ||
      (expectedSnapshotRevision !== undefined && payload.revision !== expectedSnapshotRevision)) return null;
  const pageSize = normalizedPageSize(requestedPageSize);
  return db.$transaction(async (tx) => {
    const membership = await authorizedMembership(tx, userId, teamId);
    if (!membership) return null;
    const current = await readSnapshot(tx, userId, teamId, filters);
    if (payload.filters !== current.cursorScope.filters || payload.revision !== current.cursorScope.revision) {
      return expectedSnapshotRevision === undefined ? null : { status: "snapshot_changed" };
    }
    const authorizedCursor = await tx.transaction.findFirst({
      where: { ...current.where, id: payload.id }, select: { id: true },
    });
    if (!authorizedCursor) return null;
    const rows = await tx.transaction.findMany({
      where: current.where,
      orderBy: transactionHistoryOrder,
      cursor: { id: authorizedCursor.id },
      skip: 1,
      take: pageSize + 1,
      select: transactionHistorySelect,
    });
    return toPage(rows, pageSize, current.cursorScope);
  }, { isolationLevel: "RepeatableRead" });
}
