"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Copy, Check, KeyRound, UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  type AdminActionResult, changeGlobalRoleAction, disableUserAction,
  provisionInvitationAction, reenableUserAction, restoreTeamAction,
  revokeInvitationAction, revokeTeamMembershipAction, transferTeamOwnershipAction,
} from "@/actions/admin";
import { ReauthenticateButton } from "@/components/auth/reauthenticate-button";
import { EmptyState } from "@/components/system/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Feedback } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { invitationAccessInstructions } from "@/lib/access-instructions";
import {
  ADMIN_VIEWS, ADMIN_VIEW_LABELS, adminSearchFields, adminViewHref,
  resetAdminViewPage, type AdminNavigationState,
} from "@/lib/admin-navigation";
import type { AdminConsoleDto, AdminConsoleTeamDto, AdminConsoleUserDto } from "@/lib/admin-workflows";
import { formatRoleLabel } from "@/lib/roles";

function timestamp(value: string) {
  return new Intl.DateTimeFormat("en-BD", {
    dateStyle: "medium", timeStyle: "long", timeZone: "Asia/Dhaka",
  }).format(new Date(value));
}

type Confirmation = { title: string; description: string; label: string; operation: () => Promise<AdminActionResult> };

function useAdminOperation() {
  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<AdminActionResult | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const running = useRef(false);

  function ask(next: Confirmation) {
    if (running.current) return;
    setResult(null);
    setConfirmation(next);
  }
  function execute() {
    if (!confirmation || running.current) return;
    running.current = true;
    const operation = confirmation.operation;
    startTransition(async () => {
      try {
        const response = await operation();
        setResult(response);
        if (response.status === "success") {
          toast.success(response.message);
          router.refresh();
        } else toast.error(response.message);
      } catch {
        setResult({ status: "error", message: "We could not confirm the change. Refresh this task and review the current target state before trying again." });
      } finally {
        running.current = false;
        setConfirmation(null);
      }
    });
  }
  const returnTo = `${pathname}${query.size ? `?${query}` : ""}`;
  const feedback = <>
    {result ? <Feedback tone={result.status === "error" ? "error" : "info"}>
      <p>{result.message}</p>
      {result.status === "error" && result.retryAfterSeconds ? <p>Try again in {result.retryAfterSeconds} seconds.</p> : null}
      {result.status === "error" && result.code === "RECENT_AUTHENTICATION_REQUIRED" ? <div className="mt-3 space-y-3">
        <p>Sensitive changes require a Google sign-in within the last 15 minutes. Signing in again revokes older application sessions on your other devices. You will return to this task, but sensitive input is not restored and the change will not run automatically. Review the current target and confirm again.</p>
        <ReauthenticateButton returnTo={returnTo} />
      </div> : null}
    </Feedback> : null}
    <ConfirmationDialog open={confirmation !== null} busy={isPending} title={confirmation?.title ?? "Confirm administrative change"}
      description={confirmation?.description ?? "Review the target and consequences before continuing."}
      closeLabel="Close administrative confirmation" onClose={() => { if (!running.current) setConfirmation(null); }}>
      <div className="mt-5 space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">The server will recheck your recent sign-in, permissions, and the target’s current state. This confirmation is for this attempt only.</p>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={isPending} onClick={() => setConfirmation(null)}>Cancel</Button>
          <Button type="button" disabled={isPending} onClick={execute}>{isPending ? "Applying change..." : confirmation?.label ?? "Confirm change"}</Button>
        </div>
      </div>
    </ConfirmationDialog>
  </>;
  return { ask, isPending, result, feedback };
}

function CollectionNavigation({ state, nextCursor, label, teamId }: {
  state: AdminNavigationState; nextCursor: string | null; label: string; teamId?: string;
}) {
  const cursor = teamId ? state.memberCursor : state.cursors[state.view];
  if (!cursor && !nextCursor) return null;
  const next = teamId
    ? { ...state, memberTeamId: teamId, memberCursor: nextCursor ?? undefined }
    : { ...state, cursors: { ...state.cursors, [state.view]: nextCursor ?? undefined }, memberTeamId: undefined, memberCursor: undefined };
  return <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm">
    <p className="text-muted-foreground">{nextCursor ? `More ${label} are available.` : `All ${label} on this page are loaded.`}</p>
    {cursor ? <Button asChild variant="ghost"><Link href={adminViewHref(teamId ? { ...state, memberTeamId: undefined, memberCursor: undefined } : resetAdminViewPage(state))}>First page</Link></Button> : null}
    {nextCursor ? <Button asChild variant="outline"><Link href={adminViewHref(next)}>Next page</Link></Button> : null}
  </div>;
}

function AccessInstructions({ invitation }: { invitation: NonNullable<Extract<AdminActionResult, { status: "success" }>["invitation"]> }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "fallback">("idle");
  const fallback = useRef<HTMLTextAreaElement>(null);
  if (!invitation.expiresAt) return <p className="text-sm leading-6 text-muted-foreground">{invitation.email} already has an active account. No new invitation or expiry was created.</p>;
  const instructions = invitationAccessInstructions({ ...invitation, expiresAt: invitation.expiresAt });
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(instructions);
      setCopyState("copied");
    } catch {
      setCopyState("fallback");
      requestAnimationFrame(() => { fallback.current?.focus(); fallback.current?.select(); });
    }
  }
  return <section className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-4" aria-label="Invitation access instructions">
    <h3 className="font-semibold">Share access instructions</h3>
    <dl className="space-y-2 text-sm leading-6">
      <div><dt className="font-medium">Google account</dt><dd className="wrap-anywhere">{invitation.email}</dd></div>
      <div><dt className="font-medium">Actual invitation expiry · Asia/Dhaka</dt><dd><time dateTime={invitation.expiresAt}>{timestamp(invitation.expiresAt)}</time></dd></div>
      <div><dt className="font-medium">Trusted sign-in address</dt><dd className="wrap-anywhere">{invitation.signInUrl}</dd></div>
    </dl>
    <p className="text-sm leading-6 text-muted-foreground">No email has been sent. Share these instructions with the intended person. Application admission and team approval are separate steps.</p>
    <Button type="button" variant="outline" onClick={() => void copy()}>{copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copyState === "copied" ? "Instructions copied" : "Copy access instructions"}</Button>
    <p role="status" className="text-sm leading-6">{copyState === "fallback" ? "Clipboard access was unavailable. Select and copy the instructions below." : copyState === "copied" ? "Access instructions copied. No email has been sent." : ""}</p>
    <details open={copyState === "fallback"}>
      <summary className="min-h-11 cursor-pointer rounded-lg py-3 text-sm font-medium">Select access instructions</summary>
      <Label htmlFor="invitation-instructions" className="sr-only">Access instructions to select and copy</Label>
      <Textarea ref={fallback} id="invitation-instructions" readOnly rows={8} value={instructions} onFocus={(event) => event.currentTarget.select()} />
    </details>
  </section>;
}

function InvitationProvisionForm() {
  const operation = useAdminOperation();
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("7");
  const invitation = operation.result?.status === "success" ? operation.result.invitation : undefined;
  return <div className="space-y-4">
    {operation.feedback}
    <form className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end" aria-busy={operation.isPending}
      onSubmit={(event) => { event.preventDefault(); operation.ask({ title: "Create application access?", label: "Confirm invitation",
        description: `Google account: ${email.trim().toLowerCase()}. Requested validity: ${days} days. This grants application admission only; a team Admin or Moderator must approve team access separately. No email will be sent. An existing valid invitation keeps its actual expiry.`,
        operation: () => provisionInvitationAction({ email, expiresInDays: Number(days) }),
      }); }}>
      <div className="space-y-2"><Label htmlFor="invitation-email">Google account email</Label><Input id="invitation-email" type="email" autoComplete="off" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={operation.isPending} placeholder="person@example.com" /></div>
      <div className="space-y-2"><Label htmlFor="invitation-expiry">Valid for</Label><select id="invitation-expiry" className="h-11 w-full rounded-lg border border-border bg-input px-3 text-sm" value={days} onChange={(event) => setDays(event.target.value)} disabled={operation.isPending}><option value="1">1 day</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></div>
      <Button type="submit" disabled={operation.isPending || !email.trim()}><UserPlus aria-hidden="true" />Review invitation</Button>
    </form>
    {invitation ? <AccessInstructions invitation={invitation} /> : null}
  </div>;
}

function InvitationRow({ invitation }: { invitation: AdminConsoleDto["invitations"][number] }) {
  const operation = useAdminOperation();
  return <article aria-label={`Invitation ${invitation.email}`} className="space-y-3 rounded-xl border border-border bg-card p-4">
    {operation.feedback}
    <p className="font-semibold wrap-anywhere">{invitation.email}</p>
    <p className="text-sm text-muted-foreground">{invitation.status.toLowerCase()} · expires {timestamp(invitation.expiresAt)} · Asia/Dhaka</p>
    <Button type="button" variant="outline" disabled={operation.isPending || invitation.status !== "PENDING"} onClick={() => operation.ask({
      title: "Revoke this invitation?", label: "Confirm revocation", description: `Google account: ${invitation.email}. Current invitation state: ${invitation.status.toLowerCase()}. Revocation prevents this pending invitation from admitting the account. It does not disable an already admitted account.`,
      operation: () => revokeInvitationAction(invitation.email),
    })}>Revoke invitation</Button>
  </article>;
}

function AccountCard({ user }: { user: AdminConsoleUserDto }) {
  const operation = useAdminOperation();
  const [role, setRole] = useState(user.role);
  const active = user.status === "ACTIVE";
  const disabled = user.status === "DISABLED";
  return <article aria-label={`Account ${user.email}`} className="space-y-4 rounded-xl border border-border bg-card p-4">
    {operation.feedback}
    <div><h3 className="font-semibold wrap-anywhere">{user.name}</h3><p className="mt-1 text-sm text-muted-foreground wrap-anywhere">{user.email}</p></div>
    <div className="flex flex-wrap gap-2"><StatusBadge>Global role: {formatRoleLabel(user.role)}</StatusBadge><StatusBadge tone={active ? "positive" : disabled ? "danger" : "neutral"}>{user.status.toLowerCase()}</StatusBadge>{user.ownedTeamCount > 0 ? <StatusBadge tone="warning">Owner of {user.ownedTeamCount} teams</StatusBadge> : null}</div>
    {user.ownedTeamCount > 0 ? <p className="text-sm leading-6 text-muted-foreground">Transfer all team ownership before disabling this account. Quarantined teams retain their owner; expired recovery may require operator retention review.</p> : null}
    <Button type="button" variant="outline" disabled={operation.isPending || (!active && !disabled) || (active && user.ownedTeamCount > 0)} onClick={() => operation.ask({
      title: disabled ? "Re-enable this account?" : "Disable this account?", label: disabled ? "Confirm re-enabling" : "Confirm account disablement",
      description: `${user.email} is currently ${user.status.toLowerCase()}. ${disabled ? "The account may sign in again; old sessions remain revoked." : "Application access will stop and all of this account's application sessions will be revoked."} Ownership and last-active-administrator protection are rechecked by the server.`,
      operation: () => disabled ? reenableUserAction(user.email) : disableUserAction(user.email),
    })}>{disabled ? "Re-enable account" : "Disable account"}</Button>
    <details className="border-t border-border pt-2"><summary className="min-h-11 cursor-pointer rounded-lg py-3 text-sm font-medium">Change global role</summary>
      <div className="space-y-3 pt-2"><Label htmlFor={`role-${user.email}`}>Global role</Label><Select disabled={!active || operation.isPending} value={role} onValueChange={(value) => setRole(value as typeof role)}><SelectTrigger id={`role-${user.email}`} aria-label="Global role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ADMIN">Admin</SelectItem><SelectItem value="MODERATOR">Moderator</SelectItem><SelectItem value="MEMBER">Member</SelectItem></SelectContent></Select>
        <p className="text-sm leading-6 text-muted-foreground">This changes workspace authority. Team roles and ownership remain separate.</p>
        <Button type="button" variant="outline" disabled={!active || operation.isPending || role === user.role} onClick={() => operation.ask({ title: "Change this global role?", label: "Confirm global role change", description: `${user.email}: Global role ${formatRoleLabel(user.role)} → ${formatRoleLabel(role)}. Existing application sessions will be revoked. Team roles and ownership do not change. At least one active Global Admin must remain.`, operation: () => changeGlobalRoleAction(user.email, role) })}>Review global role change</Button>
      </div>
    </details>
  </article>;
}

function TeamAccessCard({ team, state }: { team: AdminConsoleTeamDto; state: AdminNavigationState }) {
  const operation = useAdminOperation();
  const [targetEmail, setTargetEmail] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [confirmation, setConfirmation] = useState("");
  function reviewRevocation(email: string, currentState: string) {
    operation.ask({ title: "Remove this team access?", label: "Confirm membership revocation", description: `Team: ${team.name}. Account: ${email}. Current membership: ${currentState}. Team access will be revoked and this person's application sessions will be signed out. The owner must transfer ownership first.`, operation: () => revokeTeamMembershipAction(team.teamId, email) });
  }
  return <article aria-label={`Team access ${team.name}`} className="space-y-4 rounded-xl border border-border bg-card p-4">
    {operation.feedback}
    <div><h3 className="font-semibold">{team.name}</h3><p className="mt-1 text-sm text-muted-foreground wrap-anywhere">Owner: {team.ownerEmail ?? "No sign-in email on record"}</p></div>
    <h4 className="text-sm font-semibold">Memberships shown on this page</h4>
    {team.members.length === 0 ? <p className="text-sm text-muted-foreground">No matching active or pending memberships are shown.</p> : <ul className="divide-y divide-border">{team.members.map((member) => <li key={member.email} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0"><p className="font-medium wrap-anywhere">{member.name}</p><p className="text-sm text-muted-foreground wrap-anywhere">{member.email}</p><p className="text-xs leading-6 text-muted-foreground">Team role: {formatRoleLabel(member.role)} · {member.status.toLowerCase()}{member.email === team.ownerEmail ? " · Owner" : ""}</p></div>
      <Button type="button" variant="outline" disabled={operation.isPending || member.email === team.ownerEmail} onClick={() => reviewRevocation(member.email, `${member.status.toLowerCase()}, Team role ${formatRoleLabel(member.role)}`)}>{member.email === team.ownerEmail ? "Owner protected" : "Revoke membership"}</Button>
    </li>)}</ul>}
    <CollectionNavigation state={state} nextCursor={team.nextMemberCursor} label={`memberships for ${team.name}`} teamId={team.teamId} />
    <details className="border-t border-border pt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Find a membership by email</summary><div className="space-y-3 pt-2"><Label htmlFor={`revoke-${team.teamId}`}>Member Google email</Label><Input id={`revoke-${team.teamId}`} type="email" value={targetEmail} onChange={(event) => setTargetEmail(event.target.value)} maxLength={254} autoComplete="off" disabled={operation.isPending} /><Button type="button" variant="outline" disabled={!targetEmail.trim() || operation.isPending} onClick={() => reviewRevocation(targetEmail.trim().toLowerCase(), "to be checked by the server")}>Review targeted revocation</Button></div></details>
    <details className="border-t border-border pt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Transfer ownership</summary><div className="space-y-3 pt-2">
      <p className="text-sm leading-6 text-muted-foreground">The target must be an active approved team member. They become Owner and team Admin, not Global Admin. The previous owner’s team permissions remain. Both owners’ application sessions are revoked.</p>
      <Label htmlFor={`new-owner-${team.teamId}`}>New owner Google email</Label><Input id={`new-owner-${team.teamId}`} type="email" value={newOwner} onChange={(event) => setNewOwner(event.target.value)} disabled={operation.isPending} maxLength={254} autoComplete="off" list={`candidates-${team.teamId}`} />
      <datalist id={`candidates-${team.teamId}`}>{team.members.filter((member) => member.status === "APPROVED" && member.email !== team.ownerEmail).map((member) => <option value={member.email} key={member.email}>{member.name}</option>)}</datalist>
      <Label htmlFor={`owner-confirm-${team.teamId}`}>Type {team.name} to confirm</Label><Input id={`owner-confirm-${team.teamId}`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={operation.isPending} autoComplete="off" />
      <Button type="button" disabled={operation.isPending || !newOwner.trim() || confirmation !== team.name} onClick={() => operation.ask({ title: "Transfer this team's ownership?", label: "Confirm ownership transfer", description: `Team: ${team.name}. Current owner: ${team.ownerEmail ?? "unavailable"}. New owner: ${newOwner.trim().toLowerCase()}. The new owner gains team Admin authority; the previous membership is retained. Both owners will be signed out.`, operation: () => transferTeamOwnershipAction(team.teamId, newOwner, confirmation) })}><KeyRound aria-hidden="true" />Review ownership transfer</Button>
    </div></details>
  </article>;
}

function RecoveryCard({ team }: { team: AdminConsoleTeamDto }) {
  const operation = useAdminOperation();
  const [confirmation, setConfirmation] = useState("");
  const eligible = team.recoveryEligibility === "eligible";
  return <article aria-label={`Team recovery ${team.name}`} className="space-y-4 rounded-xl border border-border bg-card p-4">
    {operation.feedback}
    <h3 className="font-semibold">{team.name}</h3>
    <dl className="space-y-2 text-sm leading-6"><div><dt className="font-medium">Quarantined · Asia/Dhaka</dt><dd>{team.deletedAt ? timestamp(team.deletedAt) : "Unavailable"}</dd></div><div><dt className="font-medium">Restoration deadline · Asia/Dhaka</dt><dd>{team.purgeAfter ? <time dateTime={team.purgeAfter}>{timestamp(team.purgeAfter)}</time> : "Unavailable"}</dd></div></dl>
    <StatusBadge tone={eligible ? "warning" : "neutral"}>{eligible ? "Eligible for restoration at last server check" : "Recovery period ended"}</StatusBadge>
    <p className="text-sm leading-6 text-muted-foreground">{eligible ? "Restoration preserves the owner, memberships, approvals and complete ledger. The server rechecks the deadline when you confirm." : "Permanent deletion is not automatic. Ask the responsible operator to review retention. This screen cannot restore an expired team, purge its ledger, or bypass ownership restrictions."}</p>
    {eligible ? <div className="space-y-3"><Label htmlFor={`restore-${team.teamId}`}>Type {team.name} to restore</Label><Input id={`restore-${team.teamId}`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={operation.isPending} autoComplete="off" /><Button type="button" disabled={operation.isPending || confirmation !== team.name} onClick={() => operation.ask({ title: "Restore this quarantined team?", label: "Confirm team restoration", description: `Team: ${team.name}. Current state: quarantined. Restoration deadline: ${team.purgeAfter ? timestamp(team.purgeAfter) : "unavailable"}, Asia/Dhaka. Normal authorized team access will resume with the existing ledger and memberships.`, operation: () => restoreTeamAction(team.teamId, confirmation) })}>Restore team</Button></div> : null}
  </article>;
}

export function AdminConsole({ header, data, navigation }: { header: ReactNode; data: AdminConsoleDto; navigation: AdminNavigationState }) {
  const { view } = navigation;
  const query = navigation.queries[view];
  const search = adminSearchFields(navigation);
  const label = ADMIN_VIEW_LABELS[view];
  const nextCursor = view === "accounts" ? data.nextCursors.users : view === "invitations" ? data.nextCursors.invitations : data.nextCursors.teams;
  return <main className="page-shell min-h-screen px-3 py-5 sm:px-6 lg:px-8"><div className="mx-auto max-w-7xl space-y-6">
    {header}
    <nav aria-label="Administration tasks" className="flex flex-wrap gap-2">{ADMIN_VIEWS.map((candidate) => <Link className={`inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-sm font-medium ${candidate === view ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-muted"}`} key={candidate} href={adminViewHref(navigation, candidate)} aria-current={candidate === view ? "page" : undefined}>{ADMIN_VIEW_LABELS[candidate]}</Link>)}</nav>
    <section aria-labelledby="admin-task-heading" className="space-y-5" key={view}>
      <div><h2 id="admin-task-heading" className="text-xl font-semibold">{label}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{view === "accounts" ? "Manage active and disabled accounts. Global roles and team roles are separate; ownership blockers remain protected." : view === "invitations" ? "Create application admission, then share instructions yourself. Team membership still requires separate approval. No invitation email is sent." : view === "access" ? "Manage memberships and custody for active teams. Only the selected task is loaded." : "Review quarantined teams and their exact recovery deadlines. Permanent purge remains an operator-only action."}</p></div>
      <Card><CardContent className="p-4"><form action="/admin" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">{search.hidden.map(([name, value]) => <input type="hidden" key={name} name={name} value={value} />)}<div className="min-w-0 flex-1 space-y-2"><Label htmlFor="admin-search">Search {label.toLowerCase()}</Label><Input key={`${view}:${query}`} id="admin-search" type="search" maxLength={254} name={search.name} defaultValue={query} placeholder={view === "accounts" ? "Account name or Google email" : view === "invitations" ? "Invited Google email" : "Team name, owner or member email"} /></div><Button type="submit" variant="outline">Search</Button>{query ? <Button asChild variant="ghost"><Link href={adminViewHref(resetAdminViewPage(navigation, ""))}>Clear search</Link></Button> : null}</form></CardContent></Card>
      {view === "invitations" ? <Card><CardHeader><h3 className="font-semibold">Invite a Google account</h3></CardHeader><CardContent><InvitationProvisionForm /></CardContent></Card> : null}
      <p className="text-sm text-muted-foreground">{view === "accounts" ? data.users.length : view === "invitations" ? data.invitations.length : data.teams.length} shown on this page</p>
      <div className={view === "accounts" || view === "invitations" ? "grid items-start gap-4 lg:grid-cols-2" : "space-y-4"}>
        {view === "accounts" ? data.users.map((user) => <AccountCard key={`${user.email}:${user.status}:${user.role}`} user={user} />) : null}
        {view === "invitations" ? data.invitations.map((invitation) => <InvitationRow key={`${invitation.email}:${invitation.status}:${invitation.expiresAt}`} invitation={invitation} />) : null}
        {view === "access" ? data.teams.map((team) => <TeamAccessCard key={team.teamId} team={team} state={navigation} />) : null}
        {view === "recovery" ? data.teams.map((team) => <RecoveryCard key={team.teamId} team={team} />) : null}
      </div>
      {(view === "accounts" ? data.users.length === 0 : view === "invitations" ? data.invitations.length === 0 : data.teams.length === 0) ? <EmptyState title={query ? `No matching ${label.toLowerCase()}` : `No ${label.toLowerCase()} to show`} description={query ? "Try a different search in this task. Other tasks keep their own search and page." : view === "recovery" ? "Quarantined teams appear here. Expired retention does not trigger automatic deletion." : "There are no records in this task's current authorized page."} /> : null}
      <CollectionNavigation state={navigation} nextCursor={nextCursor} label={label.toLowerCase()} />
    </section>
  </div></main>;
}
