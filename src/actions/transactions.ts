"use server";

import { revalidatePath, refresh } from "next/cache";
import { auth } from "@/lib/auth";
import { parseTransactionDateInput } from "@/lib/date-time";
import {
  createCorrelationId,
  logServerError,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";
import {
  IdempotencyConflictError,
  InsufficientBalanceError,
  InvalidTransactionInputError,
  TransactionConflictError,
  UnauthorizedTransactionError,
  createTeamTransaction,
} from "@/lib/data/transactions";
import {
  MoneyAggregateOverflowError,
  MoneyInputError,
  formatCurrencyFromMinorUnits,
  parseMoneyToMinorUnits,
} from "@/lib/money";
import { runPostCommitTasks } from "@/lib/post-commit";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
  enforceUserRateLimit,
} from "@/lib/rate-limit";
import { transactionOperationKeySchema } from "@/lib/validators/idempotency";
import { teamIdSchema } from "@/lib/validators/team";
import {
  type TransactionFormValues,
  flattenTransactionErrors,
  transactionFormSchema,
} from "@/lib/validators/transaction";

export type TransactionActionResult =
  | {
      status: "success";
      message: string;
      transactionId: string;
      replayed: boolean;
      viewsUpdated: boolean;
    }
  | {
      status: "error";
      message: string;
      code?: "IDEMPOTENCY_CONFLICT";
      retryAfterSeconds?: number;
      fieldErrors?: Partial<Record<keyof TransactionFormValues, string>>;
    };

const TEAM_UNAVAILABLE_MESSAGE =
  "This team is unavailable or you do not have permission to change its ledger.";

export async function createTransaction(
  teamId: string,
  operationKey: string,
  input: TransactionFormValues,
): Promise<TransactionActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  const parsedTeamId = teamIdSchema.safeParse(teamId);

  if (!parsedTeamId.success) {
    return {
      status: "error",
      message: TEAM_UNAVAILABLE_MESSAGE,
    };
  }

  const parsedOperationKey = transactionOperationKeySchema.safeParse(operationKey);

  if (!parsedOperationKey.success) {
    return {
      status: "error",
      message: "This transaction request is invalid. Reload the form and try again.",
    };
  }

  const parsedInput = transactionFormSchema.safeParse(input);

  if (!parsedInput.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: flattenTransactionErrors(parsedInput.error),
    };
  }

  const correlationId = createCorrelationId();

  try {
    await enforceUserRateLimit({
      scope: "transaction-create",
      userId: session.user.id,
      limit: 60,
      windowSeconds: 60,
    });

    const result = await createTeamTransaction(session.user.id, {
      teamId: parsedTeamId.data,
      idempotencyKey: parsedOperationKey.data,
      amountInCents: parseMoneyToMinorUnits(parsedInput.data.amount),
      note: parsedInput.data.note,
      type: parsedInput.data.type,
      transactionDate: parseTransactionDateInput(
        parsedInput.data.transactionDate,
      ),
    });

    const viewsUpdated = runPostCommitTasks([
      () => revalidatePath("/dashboard"),
      () => revalidatePath(`/dashboard/${parsedTeamId.data}`),
      () => refresh(),
    ]);

    const transactionMessage = result.replayed
      ? "This transaction was already saved, so no duplicate entry was created."
      : parsedInput.data.type === "ADD"
        ? "Money added to this team ledger."
        : "Money removed from this team ledger.";

    return {
      status: "success",
      message: viewsUpdated
        ? transactionMessage
        : `${transactionMessage} The ledger is saved; refresh the page to update this view.`,
      transactionId: result.transaction.id,
      replayed: result.replayed,
      viewsUpdated,
    };
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return {
        status: "error",
        message: `Too many transaction requests. Try again in ${error.retryAfterSeconds} seconds. No transaction was attempted.`,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }

    if (error instanceof RateLimitUnavailableError) {
      return {
        status: "error",
        message:
          "Transaction protection is temporarily unavailable. No transaction was attempted. Wait a moment and try again.",
      };
    }

    if (error instanceof InsufficientBalanceError) {
      return {
        status: "error",
        message: `Insufficient balance. You currently have ${formatCurrencyFromMinorUnits(
          error.balanceInCents,
        )} available for this team.`,
      };
    }

    if (error instanceof UnauthorizedTransactionError) {
      return {
        status: "error",
        message: TEAM_UNAVAILABLE_MESSAGE,
      };
    }

    if (error instanceof IdempotencyConflictError) {
      return {
        status: "error",
        code: "IDEMPOTENCY_CONFLICT",
        message:
          "This operation key was already used for different transaction details. Review the ledger before starting a new entry.",
      };
    }

    if (
      error instanceof InvalidTransactionInputError ||
      error instanceof MoneyInputError
    ) {
      return {
        status: "error",
        message: "Please correct the highlighted amount.",
        fieldErrors: {
          amount: "Enter an amount within the supported range.",
        },
      };
    }

    if (error instanceof MoneyAggregateOverflowError) {
      return {
        status: "error",
        message:
          "This ledger has reached the supported aggregate range. No transaction was saved.",
      };
    }

    if (error instanceof TransactionConflictError) {
      return {
        status: "error",
        message:
          "A concurrent balance update prevented confirmation. Submit the unchanged form again; its operation key prevents duplicates.",
      };
    }

    logServerError(SERVER_ERROR_CATEGORY.unexpected, error, {
      correlationId,
      context: {
        operation: "transaction_create",
      },
    });

    return {
      status: "error",
      message:
        `We could not confirm this transaction. Submit the unchanged form again; its operation key prevents a duplicate if the first write committed. Reference: ${correlationId}.`,
    };
  }
}
