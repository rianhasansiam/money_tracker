import Link from "next/link";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { auth } from "@/lib/auth";
import { getDashboardData } from "@/lib/queries/dashboard";
import { canManageTeamMembership, formatRoleLabel } from "@/lib/roles";

interface TeamDashboardPageProps {
  params: Promise<{
    teamId: string;
  }>;
}

export default async function TeamDashboardPage({
  params,
}: TeamDashboardPageProps) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const { teamId } = await params;
  const dashboardData = await getDashboardData(session.user.id, teamId);

  if (!dashboardData) {
    redirect("/groups");
  }

  const firstName = session.user.name?.split(" ")[0] ?? "there";
  const viewerRoleLabel = formatRoleLabel(dashboardData.viewerRole);

  return (
    <main className="page-shell min-h-screen px-3 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="animate-entry flex flex-col gap-4 rounded-[1.35rem] border border-white/70 bg-white/75 px-4 py-4 shadow-sm backdrop-blur sm:rounded-[1.75rem] sm:px-6 sm:py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase sm:text-sm sm:tracking-[0.18em]">
              {canManageTeamMembership(dashboardData.viewerRole)
                ? "Team manager dashboard"
                : "Member dashboard"}
            </p>
            <h1 className="mt-2 wrap-break-word text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              {dashboardData.teamName}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Welcome back, {firstName}. You are viewing this group as a {" "}
              {viewerRoleLabel.toLowerCase()}, so the dashboard reflects
              only {dashboardData.teamName}&apos;s transactions and balance.
            </p>
          </div>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <Link
              href="/groups"
              className="inline-flex h-11 w-full items-center justify-center rounded-full border border-border bg-white/80 px-5 text-sm font-semibold text-foreground transition hover:bg-white sm:w-auto"
            >
              Back to groups
            </Link>
            <SignOutButton className="w-full sm:w-auto" buttonClassName="w-full" />
          </div>
        </header>

        <DashboardShell
          teamId={dashboardData.teamId}
          teamName={dashboardData.teamName}
          viewerRole={dashboardData.viewerRole}
          canManageTransactions={dashboardData.canManageTransactions}
          balanceInCents={dashboardData.balanceInCents}
          totalAddedInCents={dashboardData.totalAddedInCents}
          totalRemovedInCents={dashboardData.totalRemovedInCents}
          transactions={dashboardData.transactions}
        />
      </div>
    </main>
  );
}
