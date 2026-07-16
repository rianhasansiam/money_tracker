import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Clock3, Users } from "lucide-react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { CreateTeamForm } from "@/components/groups/create-team-form";
import { ApproveRequestButton } from "@/components/groups/approve-request-button";
import { DeleteTeamButton } from "@/components/groups/delete-team-button";
import { RequestAccessButton } from "@/components/groups/request-access-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { formatTimestampInBusinessTimeZone } from "@/lib/date-time";
import { getRateLimitedGroupsPageData } from "@/lib/queries/groups";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
} from "@/lib/rate-limit";
import {
  canCreateOrDeleteGroups,
  canManageTeamMembership,
  formatRoleLabel,
} from "@/lib/roles";
import type { GroupsPageCursors } from "@/lib/queries/groups";

export const metadata = {
  title: "Groups",
};

interface GroupsPageProps {
  searchParams: Promise<{
    membershipCursor?: string | string[];
    availableCursor?: string | string[];
    approvalCursor?: string | string[];
  }>;
}

function singleCursor(value: string | string[] | undefined) {
  if (value === undefined || typeof value === "string") {
    return value;
  }

  return "";
}

function groupsPageHref(cursors: GroupsPageCursors) {
  const params = new URLSearchParams();

  if (cursors.memberships) {
    params.set("membershipCursor", cursors.memberships);
  }

  if (cursors.availableTeams) {
    params.set("availableCursor", cursors.availableTeams);
  }

  if (cursors.adminPendingApprovals) {
    params.set("approvalCursor", cursors.adminPendingApprovals);
  }

  const query = params.toString();
  return query ? `/groups?${query}` : "/groups";
}

function CollectionPageNavigation({
  currentCursor,
  href,
  label,
  nextCursor,
}: {
  currentCursor?: string;
  href: string;
  label: string;
  nextCursor: string | null;
}) {
  if (!currentCursor && !nextCursor) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
      <p>
        {nextCursor
          ? `More ${label} exist beyond this bounded page.`
          : `This is the final page of ${label}.`}
      </p>
      {nextCursor ? (
        <Button asChild variant="outline" size="sm">
          <Link href={href}>Next page</Link>
        </Button>
      ) : null}
    </div>
  );
}

export default async function GroupsPage({ searchParams }: GroupsPageProps) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const resolvedSearchParams = await searchParams;
  const currentCursors: GroupsPageCursors = {
    memberships: singleCursor(resolvedSearchParams.membershipCursor),
    availableTeams: singleCursor(resolvedSearchParams.availableCursor),
    adminPendingApprovals: singleCursor(resolvedSearchParams.approvalCursor),
  };
  let groupsData;

  try {
    groupsData = await getRateLimitedGroupsPageData(
      session.user.id,
      currentCursors,
    );
  } catch (error) {
    if (
      error instanceof RateLimitExceededError ||
      error instanceof RateLimitUnavailableError
    ) {
      const message =
        error instanceof RateLimitExceededError
          ? `Too many group requests. Try again in ${error.retryAfterSeconds} seconds.`
          : "Group protection is temporarily unavailable. Wait a moment and try again.";

      return (
        <main className="page-shell min-h-screen px-3 py-5 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl rounded-3xl border border-white/70 bg-white/85 p-6 shadow-sm">
            <h1 className="text-xl font-semibold">Groups temporarily paused</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {message}
            </p>
            <Button asChild variant="outline" className="mt-5">
              <Link href="/">Back to home</Link>
            </Button>
          </div>
        </main>
      );
    }

    throw error;
  }

  if (!groupsData) {
    redirect("/groups");
  }

  const firstName = session.user.name?.split(" ")[0] ?? "there";
  const canManageGroups = canCreateOrDeleteGroups(session.user.role);

  return (
    <main className="page-shell min-h-screen px-3 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="animate-entry flex flex-col gap-4 rounded-[1.35rem] border border-white/70 bg-white/75 px-4 py-4 shadow-sm backdrop-blur sm:rounded-[1.75rem] sm:px-6 sm:py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase sm:text-sm sm:tracking-[0.18em]">
              Group access
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Welcome back, {firstName}.
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Join the right team, wait for an admin approval when needed, and
              open only the dashboards you belong to. Members can view team
              ledgers, while admins and moderators can handle transactions.
              Only admins can create or delete groups.
            </p>
          </div>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            {canManageGroups ? (
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <Link href="/admin">Administration</Link>
              </Button>
            ) : null}
            <SignOutButton className="w-full sm:w-auto" buttonClassName="w-full" />
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[
            {
              label: "Approved groups",
              value: groupsData.approvedTeams.length,
            },
            {
              label: "Pending requests",
              value: groupsData.pendingTeams.length,
            },
            {
              label: "Available groups",
              value: groupsData.availableTeams.length,
            },
          ].map((item, index) => (
            <Card
              key={item.label}
              className="glass-panel animate-entry border-white/75 bg-white/78"
              style={{ animationDelay: `${90 + index * 70}ms` }}
            >
              <CardContent className="flex flex-col items-start justify-between gap-3 p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase sm:text-xs sm:tracking-[0.16em]">
                    {item.label}
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">
                    {item.value}
                  </p>
                </div>
                <div className="rounded-2xl bg-primary/10 px-3 py-2 text-xs font-semibold text-primary sm:text-sm">
                  {item.value === 1 ? "1 shown" : `${item.value} shown`}
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_24rem]">
          <div className="space-y-6">
            <Card className="glass-panel animate-entry border-white/75 bg-white/82 [animation-delay:100ms]">
              <CardHeader className="space-y-2">
                <CardTitle className="text-xl">Your teams</CardTitle>
                <CardDescription>
                  Approved memberships give you access to the matching team
                  dashboard. Members can view only, while admins and moderators
                  can also transact.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {groupsData.approvedTeams.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-border/80 bg-muted/55 px-5 py-10 text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Users className="h-5 w-5" />
                    </div>
                    <p className="mt-4 text-lg font-medium text-foreground">
                      No approved teams yet
                    </p>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Request access to an existing team below, or ask an admin
                      to create a new group for your team.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {groupsData.approvedTeams.map((team) => (
                      <Card
                        key={team.teamId}
                        className="border-white/70 bg-white/80 shadow-sm"
                      >
                        <CardContent className="space-y-4 p-5">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="wrap-break-word text-lg font-semibold text-foreground">
                                {team.name}
                              </p>
                              <p className="mt-1 wrap-break-word text-sm leading-6 text-muted-foreground">
                                {team.description || "No team description yet."}
                              </p>
                            </div>
                            <span
                              className={
                                canManageTeamMembership(team.role)
                                  ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700"
                                  : "rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700"
                              }
                            >
                              {formatRoleLabel(team.role)}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 gap-3 text-sm min-[380px]:grid-cols-2">
                            <div className="rounded-2xl bg-muted/60 p-3">
                              <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase sm:text-xs sm:tracking-[0.18em]">
                                Members
                              </p>
                              <p className="mt-2 font-semibold text-foreground">
                                {team.memberCount}
                              </p>
                            </div>
                            <div className="rounded-2xl bg-muted/60 p-3">
                              <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase sm:text-xs sm:tracking-[0.18em]">
                                Pending
                              </p>
                              <p className="mt-2 font-semibold text-foreground">
                                {team.pendingRequestCount}
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                            <Button asChild className="flex-1">
                              <Link href={`/dashboard/${team.teamId}`}>
                                {canManageTeamMembership(team.role)
                                  ? "Open dashboard"
                                  : "View dashboard"}
                              </Link>
                            </Button>
                            {canManageGroups ? (
                              <DeleteTeamButton
                                teamId={team.teamId}
                                teamName={team.name}
                              />
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="glass-panel animate-entry border-white/75 bg-white/82 [animation-delay:160ms]">
              <CardHeader className="space-y-2">
                <CardTitle className="text-xl">Pending requests</CardTitle>
                <CardDescription>
                  These are the teams you have asked to join and are waiting for
                  an admin approval.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {groupsData.pendingTeams.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-border/80 bg-muted/45 px-4 py-5 text-sm leading-6 text-muted-foreground">
                    You do not have any pending join requests right now.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {groupsData.pendingTeams.map((team) => (
                      <div
                        key={team.teamId}
                        className="rounded-3xl border border-white/70 bg-white/80 p-4 shadow-sm"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="wrap-break-word font-semibold text-foreground">{team.name}</p>
                            <p className="mt-1 wrap-break-word text-sm leading-6 text-muted-foreground">
                              {team.description || "No team description yet."}
                            </p>
                          </div>
                          <span className="w-fit rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground">
                            Requested {formatTimestampInBusinessTimeZone(team.requestedAt)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <CollectionPageNavigation
                  currentCursor={currentCursors.memberships}
                  nextCursor={groupsData.nextCursors.memberships}
                  label="your memberships"
                  href={groupsPageHref({
                    ...currentCursors,
                    memberships:
                      groupsData.nextCursors.memberships ?? undefined,
                  })}
                />
              </CardContent>
            </Card>

            <Card className="glass-panel animate-entry border-white/75 bg-white/82 [animation-delay:220ms]">
              <CardHeader className="space-y-2">
                <CardTitle className="text-xl">Available teams</CardTitle>
                <CardDescription>
                  Browse teams you have not joined yet and send a join request
                  to the right admin group.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {groupsData.availableTeams.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-border/80 bg-muted/45 px-4 py-5 text-sm leading-6 text-muted-foreground">
                    Every existing team is already connected to your account, or
                    there are no other teams yet.
                  </p>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {groupsData.availableTeams.map((team) => (
                      <Card
                        key={team.teamId}
                        className="border-white/70 bg-white/80 shadow-sm"
                      >
                        <CardContent className="space-y-4 p-5">
                          <div className="min-w-0">
                            <p className="wrap-break-word text-lg font-semibold text-foreground">
                              {team.name}
                            </p>
                            <p className="mt-1 wrap-break-word text-sm leading-6 text-muted-foreground">
                              {team.description || "No team description yet."}
                            </p>
                          </div>

                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                            <RequestAccessButton teamId={team.teamId} />
                            {canManageGroups ? (
                              <DeleteTeamButton
                                teamId={team.teamId}
                                teamName={team.name}
                              />
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
                <CollectionPageNavigation
                  currentCursor={currentCursors.availableTeams}
                  nextCursor={groupsData.nextCursors.availableTeams}
                  label="available teams"
                  href={groupsPageHref({
                    ...currentCursors,
                    availableTeams:
                      groupsData.nextCursors.availableTeams ?? undefined,
                  })}
                />
              </CardContent>
            </Card>
          </div>

          <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
            {canManageGroups ? (
              <CreateTeamForm />
            ) : (
              <Card className="glass-panel border-white/75 bg-white/82">
                <CardHeader className="space-y-2">
                  <CardTitle className="text-xl">Group creation</CardTitle>
                  <CardDescription className="leading-6">
                    Only admins can create or delete groups. Moderators can
                    manage team transactions and approvals, while members can
                    request access to existing groups and view only approved
                    dashboards.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}

            <Card className="glass-panel animate-entry border-white/75 bg-white/82 [animation-delay:260ms]">
              <CardHeader className="space-y-2">
                <CardTitle className="text-xl">Admin approvals</CardTitle>
                <CardDescription>
                  If you admin or moderate a team, incoming join requests appear
                  here for review and approval.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {groupsData.adminPendingApprovals.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-border/80 bg-muted/45 px-4 py-8 text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Clock3 className="h-5 w-5" />
                    </div>
                    <p className="mt-4 font-medium text-foreground">
                      No requests waiting
                    </p>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      New join requests from members will show up here for the
                      teams you manage.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {groupsData.adminPendingApprovals.map((request) => (
                      <div
                        key={request.membershipId}
                        className="rounded-3xl border border-white/70 bg-white/80 p-4 shadow-sm"
                      >
                        <p className="wrap-break-word font-semibold text-foreground">
                          {request.requesterName || "Unknown member"}
                        </p>
                        <p className="mt-1 wrap-break-word text-sm leading-6 text-muted-foreground">
                          wants to join {request.teamName}
                        </p>
                        <p className="mt-2 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase sm:text-xs sm:tracking-[0.16em]">
                          Requested {formatTimestampInBusinessTimeZone(request.requestedAt)}
                        </p>
                        <div className="mt-4">
                          <ApproveRequestButton membershipId={request.membershipId} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <CollectionPageNavigation
                  currentCursor={currentCursors.adminPendingApprovals}
                  nextCursor={groupsData.nextCursors.adminPendingApprovals}
                  label="pending approvals"
                  href={groupsPageHref({
                    ...currentCursors,
                    adminPendingApprovals:
                      groupsData.nextCursors.adminPendingApprovals ?? undefined,
                  })}
                />
              </CardContent>
            </Card>

            <Card className="glass-panel animate-entry border-white/75 bg-white/82 [animation-delay:320ms]">
              <CardContent className="space-y-3 p-6">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">How roles work</CardTitle>
                    <CardDescription className="mt-1 text-sm">
                      Approved members can view only their approved team
                      dashboards. Approved team admins and moderators can add or
                      remove money, and only global admins can create or delete
                      groups.
                    </CardDescription>
                  </div>
                </div>
              </CardContent>
            </Card>
          </aside>
        </section>
      </div>
    </main>
  );
}
