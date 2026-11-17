"use server";

import { auth } from "@/lib/auth";
import { getApprovedTeamsPage, type ApprovedTeamsPageDto } from "@/lib/queries/teams";
import { collectionCursorSchema } from "@/lib/validators/pagination";
import { RateLimitExceededError, RateLimitUnavailableError, enforceUserRateLimit } from "@/lib/rate-limit";
import { reportUnexpectedError, SERVER_ERROR_CATEGORY } from "@/lib/observability";

export type TeamOptionsResult =
  | { status: "success"; page: ApprovedTeamsPageDto }
  | { status: "error"; message: string; retryAfterSeconds?: number };

export async function loadApprovedTeamOptions(cursor?: string): Promise<TeamOptionsResult> {
  const session = await auth();
  if (!session?.user?.id) return { status: "error", message: "Your session has expired. Sign in again to choose a team." };
  if (cursor !== undefined && !collectionCursorSchema.safeParse(cursor).success) return { status: "error", message: "This team page is unavailable. Close the switcher and try again." };
  try {
    await enforceUserRateLimit({ scope: "team-switcher", userId: session.user.id, limit: 45, windowSeconds: 60 });
    const page = await getApprovedTeamsPage(session.user.id, cursor);
    return page ? { status: "success", page } : { status: "error", message: "These teams are no longer available. Refresh the workspace before choosing a team." };
  } catch (error) {
    if (error instanceof RateLimitExceededError) return { status: "error", message: `Too many team requests. Try again in ${error.retryAfterSeconds} seconds.`, retryAfterSeconds: error.retryAfterSeconds };
    if (error instanceof RateLimitUnavailableError) return { status: "error", message: "Team protection is temporarily unavailable. Wait a moment and try again." };
    const unexpected = reportUnexpectedError(error, { category: SERVER_ERROR_CATEGORY.dataAccess, context: { operation: "approved_team_options" } });
    return { status: "error", message: unexpected.message };
  }
}
