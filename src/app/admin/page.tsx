import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ApprovedTeamSwitcher } from "@/components/system/approved-team-switcher";
import { WorkspaceHeader } from "@/components/system/workspace-header";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { AdminConsole } from "@/components/admin/admin-console";
import { Button } from "@/components/ui/button";
import { adminViewHref, readAdminNavigation, resetAdminViewPage } from "@/lib/admin-navigation";
import { auth } from "@/lib/auth";
import { getRateLimitedAdminConsoleData, type AdminConsoleCursors } from "@/lib/admin-workflows";
import { RateLimitExceededError, RateLimitUnavailableError } from "@/lib/rate-limit";

export const metadata: Metadata = {
  title: "Administration",
  description: "Task-focused account, invitation, team access and recovery operations.",
};

interface AdminPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/groups");

  const navigation = readAdminNavigation(await searchParams);
  const { view } = navigation;
  const currentCursors: AdminConsoleCursors = view === "accounts"
    ? { users: navigation.cursors.accounts }
    : view === "invitations"
      ? { invitations: navigation.cursors.invitations }
      : { teams: navigation.cursors[view], ...(view === "access" ? { memberTeamId: navigation.memberTeamId, members: navigation.memberCursor } : {}) };
  let data;
  try {
    data = await getRateLimitedAdminConsoleData(session.user.id, navigation.queries[view], currentCursors, view);
  } catch (error) {
    if (error instanceof RateLimitExceededError || error instanceof RateLimitUnavailableError) {
      return <main className="page-shell min-h-screen px-4 py-8"><section className="mx-auto max-w-2xl space-y-4 rounded-xl border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Administration temporarily paused</h1>
        <p className="text-sm leading-6 text-muted-foreground">{error instanceof RateLimitExceededError ? `Too many administration reads. Try again in ${error.retryAfterSeconds} seconds.` : "Administration read protection is temporarily unavailable. Wait a moment and try again."}</p>
        <Button asChild variant="outline"><Link href="/groups">Back to Teams</Link></Button>
      </section></main>;
    }
    throw error;
  }
  if (!data) {
    if (Object.values(currentCursors).some(Boolean)) redirect(adminViewHref(resetAdminViewPage(navigation)));
    redirect("/groups");
  }
  return <AdminConsole data={data} navigation={navigation}
    header={<WorkspaceHeader active="admin" title="Security and lifecycle console" canAdmin globalRole={session.user.role}
      teamSwitcher={<ApprovedTeamSwitcher userId={session.user.id} />}
      description={`Signed in as ${data.viewerName}. Choose a task to manage accounts, admission, team access or recovery. Sensitive changes require a recent sign-in.`}
      actions={<SignOutButton />} />} />;
}
