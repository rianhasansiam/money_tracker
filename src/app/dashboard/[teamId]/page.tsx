import Link from "next/link";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { WorkspaceHeader } from "@/components/system/workspace-header";
import { ApprovedTeamSwitcher } from "@/components/system/approved-team-switcher";
import { auth } from "@/lib/auth";
import { historyFiltersFromSearchParams, InvalidHistoryFiltersError } from "@/lib/history-filters";
import { getRateLimitedDashboardData } from "@/lib/queries/dashboard";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
} from "@/lib/rate-limit";
import { canCreateOrDeleteGroups, formatRoleLabel } from "@/lib/roles";

interface TeamDashboardPageProps {
  params: Promise<{
    teamId: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TeamDashboardPage({
  params,
  searchParams,
}: TeamDashboardPageProps) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const { teamId } = await params;
  let dashboardData;

  try {
    const filters = historyFiltersFromSearchParams(await searchParams);
    dashboardData = await getRateLimitedDashboardData(session.user.id, teamId, filters);
  } catch (error) {
    if (error instanceof InvalidHistoryFiltersError) {
      return <main className="mx-auto min-h-screen max-w-2xl px-4 py-10"><h1 className="text-2xl font-semibold">Review the history filters</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">{Object.values(error.fieldErrors).join(" ") || error.message}</p><Link href={`/dashboard/${teamId}`} className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white">Clear filters</Link></main>;
    }
    if (
      error instanceof RateLimitExceededError ||
      error instanceof RateLimitUnavailableError
    ) {
      const message =
        error instanceof RateLimitExceededError
          ? `Too many history requests. Try again in ${error.retryAfterSeconds} seconds.`
          : "History protection is temporarily unavailable. Wait a moment and try again.";

      return (
        <main className="page-shell min-h-screen px-3 py-5 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 shadow-sm">
            <h1 className="text-xl font-semibold">Dashboard temporarily paused</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {message}
            </p>
            <Link
              href="/groups"
              className="mt-5 inline-flex h-11 items-center justify-center rounded-lg border border-border bg-white px-5 text-sm font-semibold"
            >
              Back to Teams
            </Link>
          </div>
        </main>
      );
    }

    throw error;
  }

  if (!dashboardData) {
    redirect("/groups");
  }

  const viewerRoleLabel = formatRoleLabel(dashboardData.viewerRole);

  return (
    <main className="page-shell min-h-screen px-3 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <WorkspaceHeader active="dashboard" title={dashboardData.teamName} teamId={dashboardData.teamId}
          canAdmin={canCreateOrDeleteGroups(session.user.role)}
          globalRole={session.user.role}
          teamSwitcher={<ApprovedTeamSwitcher userId={session.user.id} activeTeamId={dashboardData.teamId} />}
          description={`Team role: ${viewerRoleLabel} · Balance and history belong to this team. All amounts are in BDT.`}
          actions={<SignOutButton />} />

        <DashboardShell
          key={dashboardData.snapshotScope}
          initialData={dashboardData}
        />
      </div>
    </main>
  );
}
