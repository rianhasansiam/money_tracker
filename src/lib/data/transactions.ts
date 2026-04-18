import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { calculateBalanceInCents } from "@/lib/money";
import { canManageTeamMembership } from "@/lib/roles";
import type { TransactionTypeValue } from "@/lib/validators/transaction";

export class InsufficientBalanceError extends Error {
  constructor(public readonly balanceInCents: number) {
    super("Insufficient balance.");
    this.name = "InsufficientBalanceError";
  }
}

export class TransactionConflictError extends Error {
  constructor() {
    super("Transaction conflict.");
    this.name = "TransactionConflictError";
  }
}

export class UnauthorizedTransactionError extends Error {
  constructor() {
    super("Only admins and modaretors can manage team transactions.");
    this.name = "UnauthorizedTransactionError";
  }
}

interface CreateTeamTransactionInput {
  teamId: string;
  amountInCents: number;
  note: string;
  type: TransactionTypeValue;
  transactionDate: Date;
}

export async function createTeamTransaction(
  adminId: string,
  input: CreateTeamTransactionInput,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const actor = await tx.user.findUnique({
            where: {
              id: adminId,
            },
            select: {
              teamMemberships: {
                where: {
                  teamId: input.teamId,
                  status: "APPROVED",
                },
                select: {
                  role: true,
                },
                take: 1,
              },
            },
          });

          const membershipRole = actor?.teamMemberships[0]?.role;

          if (!canManageTeamMembership(membershipRole)) {
            throw new UnauthorizedTransactionError();
          }

          const groupedTransactions = await tx.transaction.groupBy({
            by: ["type"],
            where: {
              teamId: input.teamId,
            },
            _sum: {
              amountInCents: true,
            },
          });

          const balanceInCents = calculateBalanceInCents(
            groupedTransactions.map((entry) => ({
              type: entry.type as TransactionTypeValue,
              amountInCents: entry._sum.amountInCents ?? 0,
            })),
          );

          if (input.type === "REMOVE" && input.amountInCents > balanceInCents) {
            throw new InsufficientBalanceError(balanceInCents);
          }

          return tx.transaction.create({
            data: {
              teamId: input.teamId,
              userId: adminId,
              amountInCents: input.amountInCents,
              note: input.note || null,
              type: input.type,
              transactionDate: input.transactionDate,
            },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        throw error;
      }

      if (error instanceof UnauthorizedTransactionError) {
        throw error;
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        if (attempt === 1) {
          throw new TransactionConflictError();
        }

        continue;
      }

      throw error;
    }
  }

  throw new TransactionConflictError();
}
