"use server";

import { revalidatePath, refresh } from "next/cache";
import { auth } from "@/lib/auth";
import {
  InsufficientBalanceError,
  TransactionConflictError,
  UnauthorizedTransactionError,
  createTeamTransaction,
} from "@/lib/data/transactions";
import {
  formatCurrencyFromMinorUnits,
  parseDateInput,
  parseMoneyToMinorUnits,
} from "@/lib/money";
import {
  type TransactionFormValues,
  flattenTransactionErrors,
  transactionFormSchema,
} from "@/lib/validators/transaction";

export type TransactionActionResult =
  | {
      status: "success";
      message: string;
    }
  | {
      status: "error";
      message: string;
      fieldErrors?: Partial<Record<keyof TransactionFormValues, string>>;
    };

export async function createTransaction(
  teamId: string,
  input: TransactionFormValues,
): Promise<TransactionActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
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

  try {
    await createTeamTransaction(session.user.id, {
      teamId,
      amountInCents: parseMoneyToMinorUnits(parsedInput.data.amount),
      note: parsedInput.data.note,
      type: parsedInput.data.type,
      transactionDate: parseDateInput(parsedInput.data.transactionDate),
    });

    revalidatePath("/dashboard");
    revalidatePath(`/dashboard/${teamId}`);
    refresh();

    return {
      status: "success",
      message:
        parsedInput.data.type === "ADD"
          ? "Money added to this team ledger."
          : "Money removed from this team ledger.",
    };
  } catch (error) {
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
        message:
          "Only team admins and modaretors can add or remove money from this dashboard.",
      };
    }

    if (error instanceof TransactionConflictError) {
      return {
        status: "error",
        message:
          "A balance update happened at the same time. Please try the transaction again.",
      };
    }

    return {
      status: "error",
      message: "We could not save your transaction. Please try again.",
    };
  }
}
