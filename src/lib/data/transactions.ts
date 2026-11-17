import type { Transaction } from "@prisma/client";
import { db } from "@/lib/db";
import {
  MAX_TRANSACTION_AMOUNT_IN_CENTS,
  MoneyAggregateOverflowError,
  calculateBalanceInCents,
} from "@/lib/money";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";
import { canManageTeamMembership } from "@/lib/roles";
import type { TransactionTypeValue } from "@/lib/validators/transaction";

const MAX_IDEMPOTENCY_KEY_LENGTH = 64;
const MAX_TRANSACTION_ATTEMPTS = 3;
const UNKNOWN_ACTOR_NAME = "Former team member";

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

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The operation key is already associated with another transaction.");
    this.name = "IdempotencyConflictError";
  }
}

export class InvalidTransactionInputError extends Error {
  constructor() {
    super("The transaction input is invalid.");
    this.name = "InvalidTransactionInputError";
  }
}

export class UnauthorizedTransactionError extends Error {
  constructor() {
    super("Only active admins and moderators can manage team transactions.");
    this.name = "UnauthorizedTransactionError";
  }
}

export interface CreateTeamTransactionInput {
  teamId: string;
  idempotencyKey: string;
  amountInCents: number;
  note: string;
  type: TransactionTypeValue;
  transactionDate: Date;
}

export interface CreateTeamTransactionResult {
  transaction: Transaction;
  replayed: boolean;
}

interface NormalizedTransactionInput {
  teamId: string;
  idempotencyKey: string;
  amountInCents: number;
  note: string | null;
  type: TransactionTypeValue;
  transactionDate: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectConstraintTokens(
  value: unknown,
  tokens: string[],
  seen: WeakSet<object>,
  depth = 0,
) {
  if (depth > 8 || tokens.length >= 128) {
    return;
  }

  if (typeof value === "string") {
    tokens.push(value.toLowerCase());
    return;
  }

  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectConstraintTokens(entry, tokens, seen, depth + 1);
    }

    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    tokens.push(key.toLowerCase());
    collectConstraintTokens(entry, tokens, seen, depth + 1);
  }
}

function containsIdempotencyTarget(value: unknown): boolean {
  const tokens: string[] = [];
  collectConstraintTokens(value, tokens, new WeakSet<object>());
  const combined = tokens.join(" ");

  return combined.includes("teamid") && combined.includes("idempotencykey");
}

function isIdempotencyUniqueConstraintError(error: unknown) {
  if (!hasPrismaErrorCode(error, "P2002") || !isRecord(error)) {
    return false;
  }

  return containsIdempotencyTarget(error.meta);
}

function normalizeTransactionInput(
  input: CreateTeamTransactionInput,
): NormalizedTransactionInput {
  const idempotencyKey = input.idempotencyKey.trim().toLowerCase();
  const note = input.note.trim() || null;

  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !Number.isSafeInteger(input.amountInCents) ||
    input.amountInCents <= 0 ||
    input.amountInCents > MAX_TRANSACTION_AMOUNT_IN_CENTS ||
    Number.isNaN(input.transactionDate.getTime())
  ) {
    throw new InvalidTransactionInputError();
  }

  // Date.UTC treats years 0–99 as 1900–1999. Normalize the already parsed
  // calendar date without reconstructing its year (or mutating caller input).
  const transactionDate = new Date(input.transactionDate.getTime());
  transactionDate.setUTCHours(0, 0, 0, 0);

  return {
    teamId: input.teamId,
    idempotencyKey,
    amountInCents: input.amountInCents,
    note,
    type: input.type,
    transactionDate,
  };
}

function getActorNameSnapshot(name: string | null) {
  return name?.trim() || UNKNOWN_ACTOR_NAME;
}

function isMatchingReplay(
  transaction: Transaction,
  actorId: string,
  input: NormalizedTransactionInput,
) {
  return (
    transaction.actorIdSnapshot === actorId &&
    transaction.type === input.type &&
    transaction.amountInCents === input.amountInCents &&
    transaction.note === input.note &&
    transaction.transactionDate.getTime() === input.transactionDate.getTime()
  );
}

export async function createTeamTransaction(
  actorId: string,
  input: CreateTeamTransactionInput,
): Promise<CreateTeamTransactionResult> {
  const normalizedInput = normalizeTransactionInput(input);

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const actor = await tx.user.findUnique({
            where: {
              id: actorId,
            },
            select: {
              name: true,
              status: true,
              disabledAt: true,
              deletedAt: true,
              teamMemberships: {
                where: {
                  teamId: normalizedInput.teamId,
                  status: "APPROVED",
                  team: {
                    deletedAt: null,
                  },
                },
                select: {
                  role: true,
                },
                take: 1,
              },
            },
          });

          const membershipRole = actor?.teamMemberships[0]?.role;

          if (
            !actor ||
            actor.status !== "ACTIVE" ||
            actor.disabledAt !== null ||
            actor.deletedAt !== null ||
            !canManageTeamMembership(membershipRole)
          ) {
            throw new UnauthorizedTransactionError();
          }

          const replay = await tx.transaction.findUnique({
            where: {
              teamId_idempotencyKey: {
                teamId: normalizedInput.teamId,
                idempotencyKey: normalizedInput.idempotencyKey,
              },
            },
          });

          if (replay) {
            if (!isMatchingReplay(replay, actorId, normalizedInput)) {
              throw new IdempotencyConflictError();
            }

            return {
              transaction: replay,
              replayed: true,
            };
          }

          const groupedTransactions = await tx.transaction.groupBy({
            by: ["type"],
            where: {
              teamId: normalizedInput.teamId,
            },
            _sum: {
              amountInCents: true,
            },
          });

          const currentTotals = groupedTransactions.map((entry) => ({
            type: entry.type as TransactionTypeValue,
            amountInCents: entry._sum.amountInCents ?? 0,
          }));

          if (
            currentTotals.some(
              (entry) => !Number.isSafeInteger(entry.amountInCents),
            )
          ) {
            throw new MoneyAggregateOverflowError();
          }

          const prospectiveTypeTotal =
            (currentTotals.find(
              (entry) => entry.type === normalizedInput.type,
            )?.amountInCents ?? 0) + normalizedInput.amountInCents;
          const prospectiveBalanceInCents = calculateBalanceInCents([
            ...currentTotals,
            {
              type: normalizedInput.type,
              amountInCents: normalizedInput.amountInCents,
            },
          ]);

          if (
            !Number.isSafeInteger(prospectiveTypeTotal) ||
            !Number.isSafeInteger(prospectiveBalanceInCents)
          ) {
            throw new MoneyAggregateOverflowError();
          }

          const balanceInCents = calculateBalanceInCents(currentTotals);

          if (
            normalizedInput.type === "REMOVE" &&
            normalizedInput.amountInCents > balanceInCents
          ) {
            throw new InsufficientBalanceError(balanceInCents);
          }

          const transaction = await tx.transaction.create({
            data: {
              teamId: normalizedInput.teamId,
              userId: actorId,
              idempotencyKey: normalizedInput.idempotencyKey,
              actorIdSnapshot: actorId,
              actorNameSnapshot: getActorNameSnapshot(actor.name),
              amountInCents: normalizedInput.amountInCents,
              note: normalizedInput.note,
              type: normalizedInput.type,
              transactionDate: normalizedInput.transactionDate,
            },
          });

          return {
            transaction,
            replayed: false,
          };
        },
        {
          isolationLevel: "Serializable",
        },
      );
    } catch (error) {
      if (
        error instanceof InsufficientBalanceError ||
        error instanceof IdempotencyConflictError ||
        error instanceof InvalidTransactionInputError ||
        error instanceof MoneyAggregateOverflowError ||
        error instanceof UnauthorizedTransactionError
      ) {
        throw error;
      }

      const retryable =
        hasPrismaErrorCode(error, "P2034") ||
        isIdempotencyUniqueConstraintError(error);

      if (retryable) {
        if (attempt === MAX_TRANSACTION_ATTEMPTS - 1) {
          throw new TransactionConflictError();
        }

        continue;
      }

      throw error;
    }
  }

  throw new TransactionConflictError();
}
