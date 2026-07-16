"use server";

import { auth } from "@/lib/auth";
import {
  createCorrelationId,
  reportUnexpectedError,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";
import {
  type TransactionHistoryPageDto,
  getTransactionHistoryPage,
} from "@/lib/queries/dashboard";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
  enforceUserRateLimit,
} from "@/lib/rate-limit";
import { transactionCursorSchema } from "@/lib/validators/pagination";
import { teamIdSchema } from "@/lib/validators/team";

export type TransactionHistoryActionResult =
  | {
      status: "success";
      page: TransactionHistoryPageDto;
    }
  | {
      status: "error";
      message: string;
      retryAfterSeconds?: number;
    };

const HISTORY_UNAVAILABLE_MESSAGE =
  "This transaction history page is unavailable. Refresh the dashboard and try again.";

export async function loadMoreTransactionHistory(
  teamId: string,
  cursor: string,
): Promise<TransactionHistoryActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  const parsedTeamId = teamIdSchema.safeParse(teamId);
  const parsedCursor = transactionCursorSchema.safeParse(cursor);

  if (!parsedTeamId.success || !parsedCursor.success) {
    return {
      status: "error",
      message: HISTORY_UNAVAILABLE_MESSAGE,
    };
  }

  const correlationId = createCorrelationId();

  try {
    await enforceUserRateLimit({
      scope: "transaction-history",
      userId: session.user.id,
      limit: 90,
      windowSeconds: 60,
    });

    const page = await getTransactionHistoryPage(
      session.user.id,
      parsedTeamId.data,
      parsedCursor.data,
    );

    if (!page) {
      return {
        status: "error",
        message: HISTORY_UNAVAILABLE_MESSAGE,
      };
    }

    return {
      status: "success",
      page,
    };
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return {
        status: "error",
        message: `Too many history requests. Try again in ${error.retryAfterSeconds} seconds.`,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }

    if (error instanceof RateLimitUnavailableError) {
      return {
        status: "error",
        message:
          "History protection is temporarily unavailable. Wait a moment and try again.",
      };
    }

    const unexpected = reportUnexpectedError(error, {
      category: SERVER_ERROR_CATEGORY.dataAccess,
      correlationId,
      context: { operation: "transaction_history_page" },
    });

    return {
      status: "error",
      message: unexpected.message,
    };
  }
}
