"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArchiveRestore,
  BadgeCheck,
  Ban,
  KeyRound,
  ShieldCheck,
  UserCog,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  type AdminActionResult,
  changeGlobalRoleAction,
  disableUserAction,
  provisionInvitationAction,
  reenableUserAction,
  restoreTeamAction,
  revokeInvitationAction,
  revokeTeamMembershipAction,
  transferTeamOwnershipAction,
} from "@/actions/admin";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  AdminConsoleCursors,
  AdminConsoleDto,
  AdminConsoleTeamDto,
  AdminConsoleUserDto,
} from "@/lib/admin-workflows";
import { formatRoleLabel } from "@/lib/roles";

interface AdminConsoleProps {
  data: AdminConsoleDto;
  searchQuery: string;
  currentCursors: AdminConsoleCursors;
}

function adminPageHref(
  searchQuery: string,
  cursors: AdminConsoleCursors,
) {
  const params = new URLSearchParams();

  if (searchQuery) {
    params.set("q", searchQuery);
  }

  if (cursors.users) {
    params.set("userCursor", cursors.users);
  }

  if (cursors.invitations) {
    params.set("invitationCursor", cursors.invitations);
  }

  if (cursors.teams) {
    params.set("teamCursor", cursors.teams);
  }

  if (cursors.memberTeamId) {
    params.set("memberTeamId", cursors.memberTeamId);
  }

  if (cursors.members) {
    params.set("memberCursor", cursors.members);
  }

  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}

function AdminCollectionNavigation({
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
        <Button asChild type="button" variant="outline" size="sm">
          <Link href={href}>Next page</Link>
        </Button>
      ) : null}
    </div>
  );
}

function formatAdminTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-BD", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Dhaka",
  }).format(new Date(value));
}

function useAdminOperation() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function run(operation: () => Promise<AdminActionResult>) {
    startTransition(async () => {
      try {
        const result = await operation();

        if (result.status === "error") {
          toast.error(result.message);
          return;
        }

        toast.success(result.message);
        router.refresh();
      } catch {
        toast.error(
          "We could not confirm the administrative change. Refresh the console before trying again.",
        );
      }
    });
  }

  return { isPending, run };
}

function InvitationProvisionForm() {
  const { isPending, run } = useAdminOperation();
  const [email, setEmail] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("7");

  return (
    <form
      className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        run(async () => {
          const result = await provisionInvitationAction({
            email,
            expiresInDays: Number(expiresInDays),
          });

          if (result.status === "success") {
            setEmail("");
          }

          return result;
        });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="invitation-email">Google account email</Label>
        <Input
          id="invitation-email"
          type="email"
          inputMode="email"
          autoComplete="off"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="person@example.com"
          required
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invitation-expiry">Valid for</Label>
        <select
          id="invitation-expiry"
          className="h-11 w-full rounded-2xl border border-border bg-input/60 px-3 text-sm outline-none focus-visible:ring-4 focus-visible:ring-ring"
          value={expiresInDays}
          onChange={(event) => setExpiresInDays(event.target.value)}
          disabled={isPending}
        >
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
        </select>
      </div>
      <Button type="submit" disabled={isPending || email.trim().length === 0}>
        <UserPlus className="h-4 w-4" />
        {isPending ? "Provisioning..." : "Provision"}
      </Button>
    </form>
  );
}

function UserAdministrationCard({ user }: { user: AdminConsoleUserDto }) {
  const { isPending, run } = useAdminOperation();
  const [role, setRole] = useState(user.role);
  const canDisable = user.status === "ACTIVE";
  const canEnable = user.status === "DISABLED";

  return (
    <div className="rounded-3xl border border-white/75 bg-white/78 p-4 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <p className="wrap-break-word font-semibold text-foreground">
            {user.name}
          </p>
          <p className="wrap-break-word mt-1 text-sm text-muted-foreground">
            {user.email}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-primary/10 px-3 py-1 text-primary">
              {formatRoleLabel(user.role)}
            </span>
            <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
              {user.status.toLowerCase()}
            </span>
            {user.ownedTeamCount > 0 ? (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">
                Owns {user.ownedTeamCount} {user.ownedTeamCount === 1 ? "team" : "teams"}
              </span>
            ) : null}
          </div>
        </div>

        <div className="grid w-full gap-3 sm:grid-cols-[minmax(0,12rem)_auto] xl:w-auto">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={`role-${user.email}`}>
              Global role
            </Label>
            <select
              id={`role-${user.email}`}
              className="h-10 w-full rounded-2xl border border-border bg-input/60 px-3 text-sm outline-none focus-visible:ring-4 focus-visible:ring-ring"
              value={role}
              onChange={(event) =>
                setRole(event.target.value as AdminConsoleUserDto["role"])
              }
              disabled={isPending || user.status !== "ACTIVE"}
            >
              <option value="ADMIN">Admin</option>
              <option value="MODERATOR">Moderator</option>
              <option value="MEMBER">Member</option>
            </select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-end"
            disabled={
              isPending || user.status !== "ACTIVE" || role === user.role
            }
            onClick={() => run(() => changeGlobalRoleAction(user.email, role))}
          >
            <UserCog className="h-4 w-4" />
            Apply role
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={
              canDisable
                ? "border-destructive/25 text-destructive hover:bg-destructive/5"
                : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            }
            disabled={isPending || (!canDisable && !canEnable)}
            onClick={() =>
              run(() =>
                canEnable
                  ? reenableUserAction(user.email)
                  : disableUserAction(user.email),
              )
            }
          >
            {canEnable ? (
              <BadgeCheck className="h-4 w-4" />
            ) : (
              <Ban className="h-4 w-4" />
            )}
            {isPending
              ? "Applying..."
              : canEnable
                ? "Re-enable account"
                : "Disable account"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TeamAdministrationCard({
  currentMemberCursor,
  memberPageHref,
  team,
}: {
  currentMemberCursor?: string;
  memberPageHref: string;
  team: AdminConsoleTeamDto;
}) {
  const { isPending, run } = useAdminOperation();
  const [newOwnerEmail, setNewOwnerEmail] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [confirmation, setConfirmation] = useState("");

  if (team.deletedAt && team.purgeAfter) {
    return (
      <div className="rounded-3xl border border-amber-200 bg-amber-50/75 p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-semibold text-foreground">{team.name}</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Quarantined {formatAdminTimestamp(team.deletedAt)}. Restoration
              closes {formatAdminTimestamp(team.purgeAfter)}.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(12rem,1fr)_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor={`restore-${team.teamId}`}>
                Type {team.name} to restore
              </Label>
              <Input
                id={`restore-${team.teamId}`}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                disabled={isPending}
              />
            </div>
            <Button
              type="button"
              disabled={isPending || confirmation !== team.name}
              onClick={() =>
                run(() => restoreTeamAction(team.teamId, confirmation))
              }
            >
              <ArchiveRestore className="h-4 w-4" />
              {isPending ? "Restoring..." : "Restore team"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const approvedOwnerCandidates = team.members.filter(
    (member) => member.status === "APPROVED" && member.email !== team.ownerEmail,
  );

  return (
    <div className="rounded-3xl border border-white/75 bg-white/78 p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-semibold text-foreground">{team.name}</p>
          <p className="mt-1 wrap-break-word text-sm text-muted-foreground">
            Owner: {team.ownerEmail ?? "No sign-in email on record"}
          </p>
        </div>
        <span className="w-fit rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
          Active
        </span>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
        <div className="space-y-3">
          <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
            Memberships
          </p>
          {team.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No visible memberships.</p>
          ) : (
            team.members.map((member) => {
              const isOwner = member.email === team.ownerEmail;

              return (
                <div
                  key={`${member.email}-${member.status}`}
                  className="flex flex-col gap-3 rounded-2xl bg-muted/55 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="wrap-break-word text-sm font-semibold">
                      {member.name}
                    </p>
                    <p className="wrap-break-word mt-1 text-xs text-muted-foreground">
                      {member.email} · {formatRoleLabel(member.role)} · {member.status.toLowerCase()}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-destructive/25 text-destructive hover:bg-destructive/5"
                    disabled={isPending || isOwner}
                    title={isOwner ? "Transfer ownership before revoking this membership." : undefined}
                    onClick={() =>
                      run(() =>
                        revokeTeamMembershipAction(team.teamId, member.email),
                      )
                    }
                  >
                    <Ban className="h-4 w-4" />
                    {isOwner ? "Owner" : "Revoke"}
                  </Button>
                </div>
              );
            })
          )}
          <AdminCollectionNavigation
            currentCursor={currentMemberCursor}
            nextCursor={team.nextMemberCursor}
            label={`memberships for ${team.name}`}
            href={memberPageHref}
          />
          <div className="rounded-2xl border border-border/75 bg-background/70 p-3">
            <Label htmlFor={`revoke-member-${team.teamId}`}>
              Targeted membership revocation
            </Label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Input
                id={`revoke-member-${team.teamId}`}
                type="email"
                inputMode="email"
                autoComplete="off"
                maxLength={254}
                value={memberEmail}
                onChange={(event) => setMemberEmail(event.target.value)}
                placeholder="member@example.com"
                disabled={isPending}
              />
              <Button
                type="button"
                variant="outline"
                className="border-destructive/25 text-destructive hover:bg-destructive/5"
                disabled={isPending || memberEmail.trim().length === 0}
                onClick={() =>
                  run(() =>
                    revokeTeamMembershipAction(team.teamId, memberEmail),
                  )
                }
              >
                <Ban className="h-4 w-4" />
                Revoke by email
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-border/75 bg-background/70 p-4">
          <p className="font-semibold text-foreground">Transfer ownership</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            The new owner must be an active, approved member. Both owners are
            signed out after a successful transfer.
          </p>
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`new-owner-${team.teamId}`}>New owner</Label>
              <Input
                id={`new-owner-${team.teamId}`}
                type="email"
                inputMode="email"
                autoComplete="off"
                maxLength={254}
                list={`owner-candidates-${team.teamId}`}
                value={newOwnerEmail}
                onChange={(event) => setNewOwnerEmail(event.target.value)}
                placeholder="approved.member@example.com"
                disabled={isPending}
              />
              <datalist id={`owner-candidates-${team.teamId}`}>
                {approvedOwnerCandidates.map((member) => (
                  <option key={member.email} value={member.email}>
                    {member.name} ({member.email})
                  </option>
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`transfer-confirm-${team.teamId}`}>
                Type {team.name} to confirm
              </Label>
              <Input
                id={`transfer-confirm-${team.teamId}`}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                disabled={isPending}
              />
            </div>
            <Button
              type="button"
              className="w-full"
              disabled={
                isPending ||
                newOwnerEmail.length === 0 ||
                confirmation !== team.name
              }
              onClick={() =>
                run(() =>
                  transferTeamOwnershipAction(
                    team.teamId,
                    newOwnerEmail,
                    confirmation,
                  ),
                )
              }
            >
              <KeyRound className="h-4 w-4" />
              {isPending ? "Transferring..." : "Transfer ownership"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AdminConsole({
  currentCursors,
  data,
  searchQuery,
}: AdminConsoleProps) {
  return (
    <main className="page-shell min-h-screen px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="glass-panel animate-entry rounded-[2rem] border border-white/75 p-6 sm:p-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="max-w-3xl">
              <div className="flex items-center gap-3 text-primary">
                <ShieldCheck className="h-6 w-6" />
                <p className="text-xs font-semibold tracking-[0.2em] uppercase">
                  Restricted administration
                </p>
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Security and lifecycle console
              </h1>
              <p className="mt-3 text-sm leading-7 text-muted-foreground sm:text-base">
                Signed in as {data.viewerName}. Sensitive changes require a
                recent sign-in, are rate limited, revoke affected sessions, and
                create an immutable audit event.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link href="/groups">Back to groups</Link>
            </Button>
          </div>
        </header>

        <Card className="glass-panel border-white/75 bg-white/82">
          <CardHeader>
            <CardTitle>Targeted record search</CardTitle>
            <CardDescription>
              Find users, invitations, teams, owners, or members beyond the
              bounded previews by name or normalized email.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form method="get" action="/admin" className="flex flex-col gap-3 sm:flex-row">
              <Label htmlFor="admin-search" className="sr-only">
                Search administrative records
              </Label>
              <Input
                id="admin-search"
                name="q"
                type="search"
                maxLength={254}
                defaultValue={searchQuery}
                placeholder="Name, team, or exact email"
              />
              <Button type="submit" variant="outline">
                Search
              </Button>
              {searchQuery ? (
                <Button asChild type="button" variant="ghost">
                  <Link href="/admin">Clear</Link>
                </Button>
              ) : null}
            </form>
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/75 bg-white/82">
          <CardHeader>
            <div className="flex items-center gap-3">
              <UserPlus className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Admission invitations</CardTitle>
                <CardDescription className="mt-1">
                  Provision an exact verified Google email before first sign-in.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <InvitationProvisionForm />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.invitations.map((invitation) => (
                <InvitationRow key={invitation.email} invitation={invitation} />
              ))}
            </div>
            {data.invitations.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                No invitation records are visible.
              </p>
            ) : null}
            <AdminCollectionNavigation
              currentCursor={currentCursors.invitations}
              nextCursor={data.nextCursors.invitations}
              label="invitations"
              href={adminPageHref(searchQuery, {
                ...currentCursors,
                invitations: data.nextCursors.invitations ?? undefined,
              })}
            />
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/75 bg-white/82">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Users className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Accounts and global roles</CardTitle>
                <CardDescription className="mt-1">
                  Disabling accounts and changing roles revoke their sessions.
                  Owners must transfer every team before offboarding.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 lg:grid-cols-2">
              {data.users.map((user) => (
                <UserAdministrationCard
                  key={`${user.email}:${user.role}:${user.status}`}
                  user={user}
                />
              ))}
            </div>
            <AdminCollectionNavigation
              currentCursor={currentCursors.users}
              nextCursor={data.nextCursors.users}
              label="accounts"
              href={adminPageHref(searchQuery, {
                ...currentCursors,
                users: data.nextCursors.users ?? undefined,
              })}
            />
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/75 bg-white/82">
          <CardHeader>
            <div className="flex items-center gap-3">
              <KeyRound className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Team custody</CardTitle>
                <CardDescription className="mt-1">
                  Transfer ownership, revoke memberships, or restore a
                  quarantined team before its retention window closes.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.teams.map((team) => (
              <TeamAdministrationCard
                key={team.teamId}
                team={team}
                currentMemberCursor={
                  currentCursors.memberTeamId === team.teamId
                    ? currentCursors.members
                    : undefined
                }
                memberPageHref={adminPageHref(searchQuery, {
                  ...currentCursors,
                  memberTeamId: team.teamId,
                  members: team.nextMemberCursor ?? undefined,
                })}
              />
            ))}
            <AdminCollectionNavigation
              currentCursor={currentCursors.teams}
              nextCursor={data.nextCursors.teams}
              label="teams"
              href={adminPageHref(searchQuery, {
                ...currentCursors,
                teams: data.nextCursors.teams ?? undefined,
                memberTeamId: undefined,
                members: undefined,
              })}
            />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function InvitationRow({
  invitation,
}: {
  invitation: AdminConsoleDto["invitations"][number];
}) {
  const { isPending, run } = useAdminOperation();

  return (
    <div className="rounded-2xl border border-border/75 bg-background/70 p-4">
      <p className="wrap-break-word text-sm font-semibold text-foreground">
        {invitation.email}
      </p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {invitation.status.toLowerCase()} · expires {formatAdminTimestamp(invitation.expiresAt)}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3 border-destructive/25 text-destructive hover:bg-destructive/5"
        disabled={isPending || invitation.status !== "PENDING"}
        onClick={() => run(() => revokeInvitationAction(invitation.email))}
      >
        <Ban className="h-4 w-4" />
        {isPending ? "Revoking..." : "Revoke invitation"}
      </Button>
    </div>
  );
}
