"use server";

import { auth } from "@/lib/auth";
import {
  InvalidHistoryFiltersError,
  normalizeHistoryFilters,
  type HistoryFilterFieldErrors,
} from "@/lib/history-filters";
import {
  createCorrelationId,
  reportUnexpectedError,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";
import {
  type TransactionHistoryPageDto,
  type DashboardDataDto,
  getDashboardData,
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
      code?: "SNAPSHOT_CHANGED";
      fieldErrors?: HistoryFilterFieldErrors;
      retryAfterSeconds?: number;
    };

const HISTORY_UNAVAILABLE_MESSAGE =
  "This transaction history page is unavailable. Refresh the dashboard and try again.";

export async function loadMoreTransactionHistory(
  teamId: string,
  cursor: string,
  snapshotRevision: string,
  input: unknown = {},
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

  if (
    !parsedTeamId.success || !parsedCursor.success ||
    typeof snapshotRevision !== "string" || !/^[a-f0-9]{64}$/.test(snapshotRevision)
  ) {
    return {
      status: "error",
      message: HISTORY_UNAVAILABLE_MESSAGE,
    };
  }

  const correlationId = createCorrelationId();

  try {
    const filters = normalizeHistoryFilters(input);
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
      undefined,
      snapshotRevision,
      filters,
    );

    if (!page) {
      return {
        status: "error",
        message: HISTORY_UNAVAILABLE_MESSAGE,
      };
    }

    if ("status" in page) {
      return {
        status: "error",
        code: "SNAPSHOT_CHANGED",
        message: "The ledger or history view changed while you were reading. Refresh the matching history and totals before loading older entries.",
      };
    }

    return {
      status: "success",
      page,
    };
  } catch (error) {
    if (error instanceof InvalidHistoryFiltersError) {
      return { status: "error", message: error.message, fieldErrors: error.fieldErrors };
    }
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

export type FilteredDashboardActionResult =
  | { status: "success"; data: DashboardDataDto }
  | { status: "error"; message: string; fieldErrors?: HistoryFilterFieldErrors; retryAfterSeconds?: number };

/** Search is POST data only; it is never copied into a route or log context. */
export async function loadFilteredDashboard(
  teamId: string,
  input: unknown = {},
): Promise<FilteredDashboardActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { status: "error", message: "Your session has expired. Please sign in again." };
  }
  const parsedTeamId = teamIdSchema.safeParse(teamId);
  if (!parsedTeamId.success) {
    return { status: "error", message: HISTORY_UNAVAILABLE_MESSAGE };
  }
  const correlationId = createCorrelationId();
  const now = new Date();
  try {
    const filters = normalizeHistoryFilters(input, now);
    await enforceUserRateLimit({
      scope: "transaction-history", userId: session.user.id, limit: 90, windowSeconds: 60,
    });
    const data = await getDashboardData(session.user.id, parsedTeamId.data, { filters, now });
    return data
      ? { status: "success", data }
      : { status: "error", message: HISTORY_UNAVAILABLE_MESSAGE };
  } catch (error) {
    if (error instanceof InvalidHistoryFiltersError) {
      return { status: "error", message: error.message, fieldErrors: error.fieldErrors };
    }
    if (error instanceof RateLimitExceededError) {
      return { status: "error", message: `Too many history requests. Try again in ${error.retryAfterSeconds} seconds.`, retryAfterSeconds: error.retryAfterSeconds };
    }
    if (error instanceof RateLimitUnavailableError) {
      return { status: "error", message: "History protection is temporarily unavailable. Wait a moment and try again." };
    }
    const unexpected = reportUnexpectedError(error, {
      category: SERVER_ERROR_CATEGORY.dataAccess,
      correlationId,
      context: { operation: "transaction_history_filter" },
    });
    return { status: "error", message: unexpected.message };
  }
}
