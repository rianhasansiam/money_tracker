import { db } from "@/lib/db";
import { calculateBalanceInCents } from "@/lib/money";
import type { TeamMembershipRoleValue } from "@/lib/queries/groups";
import { canManageTeamMembership } from "@/lib/roles";

export type DashboardTransactionType = "ADD" | "REMOVE";

export interface DashboardTransaction {
  id: string;
  amountInCents: number;
  note: string | null;
  type: DashboardTransactionType;
  transactionDate: Date;
  createdAt: Date;
  createdByName: string | null;
  createdByEmail: string | null;
}

export interface DashboardData {
  teamId: string;
  teamName: string;
  teamDescription: string | null;
  viewerRole: TeamMembershipRoleValue;
  canManageTransactions: boolean;
  balanceInCents: number;
  totalAddedInCents: number;
  totalRemovedInCents: number;
  transactions: DashboardTransaction[];
}

export async function getDashboardData(
  userId: string,
  teamId: string,
): Promise<DashboardData | null> {
  const membership = await db.teamMembership.findUnique({
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
          description: true,
        },
      },
    },
  });

  if (!membership || membership.status !== "APPROVED") {
    return null;
  }

  const [groupedTransactions, transactions] = await Promise.all([
    db.transaction.groupBy({
      by: ["type"],
      where: {
        teamId,
      },
      _sum: {
        amountInCents: true,
      },
    }),
    db.transaction.findMany({
      where: {
        teamId,
      },
      orderBy: [
        {
          transactionDate: "desc",
        },
        {
          createdAt: "desc",
        },
        {
          id: "desc",
        },
      ],
      select: {
        id: true,
        amountInCents: true,
        note: true,
        type: true,
        transactionDate: true,
        createdAt: true,
        createdBy: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    }),
  ]);

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
    teamDescription: membership.team.description,
    viewerRole: membership.role as TeamMembershipRoleValue,
    canManageTransactions: canManageTeamMembership(membership.role),
    balanceInCents: calculateBalanceInCents(totals),
    totalAddedInCents,
    totalRemovedInCents,
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      amountInCents: transaction.amountInCents,
      note: transaction.note,
      type: transaction.type as DashboardTransactionType,
      transactionDate: transaction.transactionDate,
      createdAt: transaction.createdAt,
      createdByName: transaction.createdBy.name,
      createdByEmail: transaction.createdBy.email,
    })),
  };
}
