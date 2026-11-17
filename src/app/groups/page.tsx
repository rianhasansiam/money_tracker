import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, ChevronRight, Plus, ShieldCheck } from "lucide-react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { ApproveRequestButton } from "@/components/groups/approve-request-button";
import { CreateTeamForm } from "@/components/groups/create-team-form";
import { DeleteTeamButton } from "@/components/groups/delete-team-button";
import { RequestAccessButton } from "@/components/groups/request-access-button";
import { ApprovedTeamSwitcher } from "@/components/system/approved-team-switcher";
import { EmptyState } from "@/components/system/empty-state";
import { WorkspaceHeader } from "@/components/system/workspace-header";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/ui/feedback";
import { StatusBadge } from "@/components/ui/status-badge";
import { auth } from "@/lib/auth";
import { formatTimestampInBusinessTimeZone } from "@/lib/date-time";
import { getRateLimitedTeamsWorkspaceData } from "@/lib/queries/teams";
import { RateLimitExceededError, RateLimitUnavailableError } from "@/lib/rate-limit";
import { canCreateOrDeleteGroups, formatRoleLabel } from "@/lib/roles";
import { parseTeamsLocation, teamsPageHref, type TeamsView, type TeamsViewCursors } from "@/lib/validators/teams-view";

export const metadata = { title: "Teams" };
const viewLabels: Record<TeamsView, string> = {
  teams: "Your teams", discover: "Discover teams", requests: "Your requests", approvals: "Approvals",
};

function PageNavigation({ view, cursors, nextCursor, shown }: { view: TeamsView; cursors: TeamsViewCursors; nextCursor: string | null; shown: number }) {
  return <nav aria-label={`${viewLabels[view]} pagination`} className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
    <p className="text-xs text-muted-foreground">{shown} shown on this page{nextCursor ? " · More available" : " · End of results"}</p>
    <div className="flex flex-wrap gap-2">
      {cursors[view] ? <Button asChild variant="ghost"><Link href={teamsPageHref(view, { ...cursors, [view]: undefined })}>First page</Link></Button> : null}
      {nextCursor ? <Button asChild variant="outline"><Link href={teamsPageHref(view, { ...cursors, [view]: nextCursor })}>Next page<ChevronRight aria-hidden="true" /></Link></Button> : null}
    </div>
  </nav>;
}

function TeamManagement({ teamId, teamName, returnTo }: { teamId: string; teamName: string; returnTo: string }) {
  return <details className="mt-4 border-t border-border pt-2">
    <summary className="flex min-h-11 cursor-pointer list-item items-center text-sm font-medium text-muted-foreground">Team management</summary>
    <div className="space-y-3 pb-1 pt-2">
      <p className="text-xs leading-5 text-muted-foreground">Global Admin action. Quarantine stops access and preserves the ledger during its recovery window.</p>
      <DeleteTeamButton teamId={teamId} teamName={teamName} returnTo={returnTo} />
    </div>
  </details>;
}

export default async function TeamsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const location = parseTeamsLocation(await searchParams);
  if (!location) redirect("/groups");
  let data;
  try {
    data = await getRateLimitedTeamsWorkspaceData(session.user.id, location.view, location.cursors);
  } catch (error) {
    if (!(error instanceof RateLimitExceededError || error instanceof RateLimitUnavailableError)) throw error;
    return <main className="mx-auto min-h-screen max-w-2xl px-4 py-10"><Feedback tone="warning">{error instanceof RateLimitExceededError ? `Too many team requests. Try again in ${error.retryAfterSeconds} seconds.` : "Team protection is temporarily unavailable. Wait a moment and try again."}</Feedback><Button asChild variant="outline" className="mt-4"><Link href="/">Return home</Link></Button></main>;
  }
  if (!data) redirect("/groups");
  const canManage = canCreateOrDeleteGroups(data.globalRole);
  const viewHref = teamsPageHref(data.view, location.cursors);
  const shown = data.approvedTeams.length + data.discoverableTeams.length + data.pendingRequests.length + data.incomingRequests.length;
  const views: TeamsView[] = ["teams", "discover", "requests", ...(data.canReviewRequests ? ["approvals" as const] : [])];

  return <main className="min-h-screen px-4 py-5 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-7xl space-y-6">
      <WorkspaceHeader active="groups" title="Teams" globalRole={data.globalRole} canAdmin={canManage}
        description="Open a team you belong to, request access, or review membership requests. Each team has its own ledger and Team role."
        teamSwitcher={<ApprovedTeamSwitcher userId={session.user.id} />} actions={<SignOutButton />} />

      {!data.hasApprovedTeams ? <Feedback>
        <p className="font-medium">Your account is active. Request access to a team to view its ledger.</p>
        <p className="mt-1">{data.hasPendingRequests ? "Your pending requests must be approved by a Team Admin or Team Moderator. You can review those requests or discover another team while you wait." : "Choose Discover teams, find the right team, and request to join. Signing in and team approval are separate steps."}</p>
      </Feedback> : null}

      <div className="flex flex-col justify-between gap-4 border-b border-border pb-4 lg:flex-row lg:items-end">
        <nav aria-label="Teams views" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {views.map((view) => <Link key={view} href={teamsPageHref(view, location.cursors)} aria-current={data.view === view ? "page" : undefined}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${data.view === view ? "border-primary bg-primary text-white" : "border-border bg-card text-muted-foreground hover:bg-muted"}`}>
            <span className="whitespace-nowrap">{viewLabels[view]}</span>{view === "approvals" && data.hasIncomingRequests ? <span className={`rounded px-1.5 py-0.5 text-[11px] ${data.view === view ? "bg-white text-primary" : "bg-amber-50 text-warning"}`}><span aria-hidden="true" className="font-bold sm:hidden">!</span><span aria-hidden="true" className="hidden whitespace-nowrap sm:inline">Action needed</span><span className="sr-only"> Action needed</span></span> : null}
          </Link>)}
        </nav>
        {canManage ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />Global Admin: team creation and management available below</p> : null}
      </div>

      <section aria-labelledby="teams-task-heading" className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <div className="mb-5 space-y-2">
          <h2 id="teams-task-heading" className="text-xl font-semibold">{viewLabels[data.view]}</h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{{ teams: "These approved memberships let you open the team's ledger. Your Team role determines whether you can record money or review requests.", discover: "Find the team you need. Only its name and description are shown until your membership is approved.", requests: "Your outgoing requests are awaiting approval. An approved Team Admin or Team Moderator for that team must approve you before you can open its ledger.", approvals: "Review incoming requests for teams where your approved Team role is Admin or Moderator. Your Global role alone does not grant approval rights." }[data.view]}</p>
        </div>

        {data.view === "teams" ? data.approvedTeams.length ? <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Your approved teams">
          {data.approvedTeams.map((team) => <li key={team.teamId} className="min-w-0 rounded-lg border border-border p-4">
            <div className="flex items-start justify-between gap-3"><h3 className="text-lg font-semibold wrap-anywhere">{team.name}</h3>{team.isOwner ? <StatusBadge>Owner</StatusBadge> : null}</div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground wrap-anywhere">{team.description || "No team description provided."}</p>
            <p className="mt-4 text-sm font-medium">Team role: {formatRoleLabel(team.teamRole)}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{team.teamRole === "MEMBER" ? "View-only access to balance and history." : "Can record money and approve team requests."}</p>
            <Button asChild className="mt-4 w-full"><Link href={`/dashboard/${team.teamId}`}>Open team<ChevronRight aria-hidden="true" /></Link></Button>
            {canManage ? <TeamManagement teamId={team.teamId} teamName={team.name} returnTo={viewHref} /> : null}
          </li>)}
        </ul> : <EmptyState title={data.hasApprovedTeams ? "No teams on this page" : "No approved teams yet"} description={data.hasApprovedTeams ? "Your approved memberships are on another page. Return to the first page to choose a team." : "Request access to a team first. Its Team Admin or Team Moderator must approve you before its ledger becomes available."} action={<Button asChild><Link href={data.hasApprovedTeams ? teamsPageHref("teams", { ...location.cursors, teams: undefined }) : teamsPageHref("discover", location.cursors)}>{data.hasApprovedTeams ? "First page" : "Discover teams"}</Link></Button>} /> : null}

        {data.view === "discover" ? data.discoverableTeams.length ? <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Teams available to request">
          {data.discoverableTeams.map((team) => <li key={team.teamId} className="min-w-0 rounded-lg border border-border p-4">
            <Building2 className="mb-3 h-5 w-5 text-primary" aria-hidden="true" /><h3 className="text-lg font-semibold wrap-anywhere">{team.name}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground wrap-anywhere">{team.description || "No team description provided."}</p>
            <p className="my-4 text-xs leading-5 text-muted-foreground">Approval is required before ledger access.</p>
            <RequestAccessButton teamId={team.teamId} requestsHref={teamsPageHref("requests", location.cursors)} />
            {canManage ? <TeamManagement teamId={team.teamId} teamName={team.name} returnTo={viewHref} /> : null}
          </li>)}
        </ul> : <EmptyState title="No available teams on this page" description="Teams you have joined, requested, or had revoked access to are not listed as available. If you need another team, ask a Global Admin about access or creation." action={<Button asChild variant="outline"><Link href={teamsPageHref(data.hasPendingRequests ? "requests" : "teams", location.cursors)}>{data.hasPendingRequests ? "View your requests" : "Your teams"}</Link></Button>} /> : null}

        {data.view === "requests" ? data.pendingRequests.length ? <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Your pending team requests">
          {data.pendingRequests.map((request) => <li key={request.teamId} className="space-y-2 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="font-semibold wrap-anywhere">{request.name}</h3><StatusBadge tone="warning">Awaiting team approval</StatusBadge></div><p className="text-sm leading-6 text-muted-foreground wrap-anywhere">{request.description || "No team description provided."}</p><p className="text-xs leading-5 text-muted-foreground">Requested {formatTimestampInBusinessTimeZone(request.requestedAt)} · A Team Admin or Team Moderator must approve this request.</p></li>)}
        </ul> : <EmptyState title={data.hasPendingRequests ? "No requests on this page" : "No pending requests"} description={data.hasPendingRequests ? "Your pending requests are on another page. Return to the first page to review them." : "Request access from Discover teams. Approved memberships move to Your teams."} action={<Button asChild><Link href={data.hasPendingRequests ? teamsPageHref("requests", { ...location.cursors, requests: undefined }) : teamsPageHref("discover", location.cursors)}>{data.hasPendingRequests ? "First page" : "Discover teams"}</Link></Button>} /> : null}

        {data.view === "approvals" ? data.incomingRequests.length ? <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Incoming team requests">
          {data.incomingRequests.map((request) => <li key={request.membershipId} className="flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center"><div className="min-w-0"><h3 className="font-semibold wrap-anywhere">{request.requesterName || "Unnamed member"}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground wrap-anywhere">Requests access to <span className="font-medium text-foreground">{request.teamName}</span></p><p className="mt-1 text-xs text-muted-foreground">Requested {formatTimestampInBusinessTimeZone(request.requestedAt)}</p></div><ApproveRequestButton membershipId={request.membershipId} /></li>)}
        </ul> : <EmptyState title={data.hasIncomingRequests ? "No requests on this page" : "No requests waiting"} description={data.hasIncomingRequests ? "Requests await review on another page. Return to the first page to review them." : "Incoming requests appear here only for teams where you are an approved Team Admin or Team Moderator."} action={data.hasIncomingRequests ? <Button asChild variant="outline"><Link href={teamsPageHref("approvals", { ...location.cursors, approvals: undefined })}>First page</Link></Button> : undefined} /> : null}

        <PageNavigation view={data.view} cursors={location.cursors} nextCursor={data.nextCursor} shown={shown} />
      </section>

      {canManage ? <details className="rounded-xl border border-border bg-card p-4 sm:p-6"><summary className="flex min-h-11 cursor-pointer list-item items-center gap-2 font-semibold"><Plus className="h-4 w-4" aria-hidden="true" />Create team <span className="ml-1 text-xs font-normal text-muted-foreground">Global Admin</span></summary><div className="mt-4 max-w-xl"><CreateTeamForm /></div></details> : null}
    </div>
  </main>;
}
