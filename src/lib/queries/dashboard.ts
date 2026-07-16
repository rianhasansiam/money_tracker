import { db } from "@/lib/db";
import { toTransactionDateInputValue } from "@/lib/date-time";
import { calculateBalanceInCents } from "@/lib/money";
import type { TeamMembershipRoleValue } from "@/lib/queries/groups";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { canManageTeamMembership } from "@/lib/roles";

export const TRANSACTION_HISTORY_PAGE_SIZE = 25;
export const TRANSACTION_HISTORY_MAX_PAGE_SIZE = 50;

export type DashboardTransactionType = "ADD" | "REMOVE";

/** Privacy-reviewed ledger row safe to serialize to an authorized member. */
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

/** Privacy-reviewed dashboard payload safe to pass to the dashboard client shell. */
export interface DashboardDataDto {
  teamId: string;
  teamName: string;
  viewerRole: TeamMembershipRoleValue;
  canManageTransactions: boolean;
  balanceInCents: number;
  totalAddedInCents: number;
  totalRemovedInCents: number;
  transactionHistory: TransactionHistoryPageDto;
}

// Compatibility aliases for imports outside this module while keeping DTO naming explicit.
export type DashboardTransaction = DashboardTransactionDto;
export type DashboardData = DashboardDataDto;

interface DashboardReadSynchronization {
  /** Integration-test barrier only. This must never be populated from request data. */
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

function normalizePageSize(requestedPageSize: number) {
  if (!Number.isFinite(requestedPageSize)) {
    return TRANSACTION_HISTORY_PAGE_SIZE;
  }

  return Math.min(
    TRANSACTION_HISTORY_MAX_PAGE_SIZE,
    Math.max(1, Math.floor(requestedPageSize)),
  );
}

function toTransactionDto(
  transaction: TransactionProjection,
): DashboardTransactionDto {
  return {
    id: transaction.id,
    amountInCents: transaction.amountInCents,
    note: transaction.note,
    type: transaction.type as DashboardTransactionType,
    transactionDate: toTransactionDateInputValue(transaction.transactionDate),
    createdByName: transaction.actorNameSnapshot,
  };
}

function toHistoryPage(
  rows: TransactionProjection[],
  pageSize: number,
): TransactionHistoryPageDto {
  const hasNextPage = rows.length > pageSize;
  const pageRows = hasNextPage ? rows.slice(0, pageSize) : rows;

  return {
    transactions: pageRows.map(toTransactionDto),
    nextCursor:
      hasNextPage && pageRows.length > 0
        ? pageRows[pageRows.length - 1]?.id ?? null
        : null,
  };
}

const transactionHistoryOrder = [
  {
    transactionDate: "desc" as const,
  },
  {
    createdAt: "desc" as const,
  },
  {
    id: "desc" as const,
  },
];

const transactionHistorySelect = {
  id: true,
  amountInCents: true,
  note: true,
  type: true,
  transactionDate: true,
  actorNameSnapshot: true,
} as const;

export async function getDashboardData(
  userId: string,
  teamId: string,
  synchronization: DashboardReadSynchronization = {},
): Promise<DashboardDataDto | null> {
  return db.$transaction(
    async (tx) => {
      const membership = await tx.teamMembership.findUnique({
        where: {
          teamId_userId: {
            teamId,
            userId,
          },
        },
        select: {
          role: true,
          status: true,
          team: {
            select: {
              id: true,
              name: true,
              deletedAt: true,
            },
          },
        },
      });

      if (
        !membership ||
        membership.status !== "APPROVED" ||
        membership.team.deletedAt !== null
      ) {
        return null;
      }

      const groupedTransactions = await tx.transaction.groupBy({
        by: ["type"],
        where: {
          teamId,
        },
        _sum: {
          amountInCents: true,
        },
      });

      await synchronization.afterAggregate?.();

      const transactions = await tx.transaction.findMany({
        where: {
          teamId,
        },
        orderBy: transactionHistoryOrder,
        take: TRANSACTION_HISTORY_PAGE_SIZE + 1,
        select: transactionHistorySelect,
      });

      const totals = groupedTransactions.map((entry) => ({
        type: entry.type as DashboardTransactionType,
        amountInCents: entry._sum.amountInCents ?? 0,
      }));
      const totalAddedInCents =
        totals.find((entry) => entry.type === "ADD")?.amountInCents ?? 0;
      const totalRemovedInCents =
        totals.find((entry) => entry.type === "REMOVE")?.amountInCents ?? 0;

      return {
        teamId: membership.team.id,
        teamName: membership.team.name,
        viewerRole: membership.role as TeamMembershipRoleValue,
        canManageTransactions: canManageTeamMembership(membership.role),
        balanceInCents: calculateBalanceInCents(totals),
        totalAddedInCents,
        totalRemovedInCents,
        transactionHistory: toHistoryPage(
          transactions as TransactionProjection[],
          TRANSACTION_HISTORY_PAGE_SIZE,
        ),
      };
    },
    {
      isolationLevel: "RepeatableRead",
    },
  );
}

export async function getRateLimitedDashboardData(userId: string, teamId: string) {
  await enforceUserRateLimit({
    scope: "transaction-history",
    userId,
    limit: 90,
    windowSeconds: 60,
  });

  return getDashboardData(userId, teamId);
}

export async function getTransactionHistoryPage(
  userId: string,
  teamId: string,
  cursor: string,
  requestedPageSize = TRANSACTION_HISTORY_PAGE_SIZE,
): Promise<TransactionHistoryPageDto | null> {
  const pageSize = normalizePageSize(requestedPageSize);

  return db.$transaction(
    async (tx) => {
      const membership = await tx.teamMembership.findUnique({
        where: {
          teamId_userId: {
            teamId,
            userId,
          },
        },
        select: {
          status: true,
          team: {
            select: {
              deletedAt: true,
            },
          },
        },
      });

      if (
        !membership ||
        membership.status !== "APPROVED" ||
        membership.team.deletedAt !== null
      ) {
        return null;
      }

      const authorizedCursor = await tx.transaction.findFirst({
        where: {
          id: cursor,
          teamId,
        },
        select: {
          id: true,
        },
      });

      if (!authorizedCursor) {
        return null;
      }

      const rows = await tx.transaction.findMany({
        where: {
          teamId,
        },
        orderBy: transactionHistoryOrder,
        cursor: {
          id: authorizedCursor.id,
        },
        skip: 1,
        take: pageSize + 1,
        select: transactionHistorySelect,
      });

      return toHistoryPage(rows as TransactionProjection[], pageSize);
    },
    {
      isolationLevel: "RepeatableRead",
    },
  );
}
