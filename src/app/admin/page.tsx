import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminConsole } from "@/components/admin/admin-console";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import {
  type AdminConsoleCursors,
  getRateLimitedAdminConsoleData,
} from "@/lib/admin-workflows";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
} from "@/lib/rate-limit";

export const metadata: Metadata = {
  title: "Administration",
  description: "Security-sensitive account, invitation, and team operations.",
};

interface AdminPageProps {
  searchParams: Promise<{
    q?: string | string[];
    userCursor?: string | string[];
    invitationCursor?: string | string[];
    teamCursor?: string | string[];
    memberTeamId?: string | string[];
    memberCursor?: string | string[];
  }>;
}

function singleValue(value: string | string[] | undefined) {
  if (value === undefined || typeof value === "string") {
    return value;
  }

  return "";
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const resolvedSearchParams = await searchParams;
  const queryValue = resolvedSearchParams.q;
  const searchQuery =
    typeof queryValue === "string" ? queryValue.trim().slice(0, 254) : "";
  const currentCursors: AdminConsoleCursors = {
    users: singleValue(resolvedSearchParams.userCursor),
    invitations: singleValue(resolvedSearchParams.invitationCursor),
    teams: singleValue(resolvedSearchParams.teamCursor),
    memberTeamId: singleValue(resolvedSearchParams.memberTeamId),
    members: singleValue(resolvedSearchParams.memberCursor),
  };
  let consoleData;

  try {
    consoleData = await getRateLimitedAdminConsoleData(
      session.user.id,
      searchQuery,
      currentCursors,
    );
  } catch (error) {
    if (
      error instanceof RateLimitExceededError ||
      error instanceof RateLimitUnavailableError
    ) {
      const message =
        error instanceof RateLimitExceededError
          ? `Too many administration reads. Try again in ${error.retryAfterSeconds} seconds.`
          : "Administration read protection is temporarily unavailable. Wait a moment and try again.";

      return (
        <main className="page-shell min-h-screen px-4 py-8 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl rounded-3xl border border-white/70 bg-white/85 p-6 shadow-sm">
            <h1 className="text-xl font-semibold">Administration temporarily paused</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {message}
            </p>
            <Button asChild variant="outline" className="mt-5">
              <Link href="/groups">Back to groups</Link>
            </Button>
          </div>
        </main>
      );
    }

    throw error;
  }

  if (!consoleData) {
    if (Object.values(currentCursors).some(Boolean)) {
      redirect(searchQuery ? `/admin?q=${encodeURIComponent(searchQuery)}` : "/admin");
    }

    redirect("/groups");
  }

  return (
    <AdminConsole
      data={consoleData}
      searchQuery={searchQuery}
      currentCursors={currentCursors}
    />
  );
}
