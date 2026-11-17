"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Check, ChevronsUpDown, LoaderCircle } from "lucide-react";
import { loadApprovedTeamOptions } from "@/actions/team-navigation";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Feedback } from "@/components/ui/feedback";
import type { ApprovedTeamOptionDto, ApprovedTeamsPageDto } from "@/lib/queries/teams";
import { formatRoleLabel } from "@/lib/roles";

export function TeamSwitcher({ initialPage, activeTeam }: { initialPage: ApprovedTeamsPageDto; activeTeam: ApprovedTeamOptionDto | null }) {
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState(() => activeTeam && !initialPage.teams.some((team) => team.teamId === activeTeam.teamId)
    ? [activeTeam, ...initialPage.teams]
    : initialPage.teams);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const activeRef = useRef(true);
  const loadingRef = useRef(false);
  const loadButtonRef = useRef<HTMLButtonElement>(null);
  const countRef = useRef<HTMLParagraphElement>(null);
  const focusCountRef = useRef(false);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);
  useEffect(() => {
    if (!nextCursor && focusCountRef.current) {
      focusCountRef.current = false;
      countRef.current?.focus({ preventScroll: true });
    }
  }, [nextCursor]);

  function loadMore() {
    if (!nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    startTransition(async () => {
      try {
        const result = await loadApprovedTeamOptions(nextCursor);
        if (!activeRef.current) return;
        if (result.status === "error") { setError(result.message); return; }
        focusCountRef.current = result.page.nextCursor === null && document.activeElement === loadButtonRef.current;
        setTeams((current) => {
          const ids = new Set(current.map((team) => team.teamId));
          return [...current, ...result.page.teams.filter((team) => !ids.has(team.teamId))];
        });
        setNextCursor(result.page.nextCursor);
        setError(null);
      } catch {
        if (activeRef.current) setError("We could not load more teams. Try again in a moment.");
      } finally { loadingRef.current = false; }
    });
  }

  return <>
    <Button type="button" variant="outline" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="max-w-full justify-between px-3 text-left sm:max-w-72">
      <span className="min-w-0 truncate">{activeTeam ? activeTeam.name : "Choose a team"}</span>
      <ChevronsUpDown aria-hidden="true" />
    </Button>
    <ConfirmationDialog closeLabel="Close team switcher" open={open} busy={false} onClose={() => setOpen(false)} title="Switch team" description="Only active teams with your approved membership are available. Each team has a separate ledger and Team role.">
      <div className="mt-5 space-y-4">
        {teams.length === 0 ? <p className="text-sm leading-6 text-muted-foreground">You do not have an approved team yet. Open Teams to discover a team and request access.</p> : <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Approved active teams">
          {teams.map((team) => <li key={team.teamId}>
            <Link href={`/dashboard/${team.teamId}`} onClick={() => setOpen(false)} aria-current={activeTeam?.teamId === team.teamId ? "page" : undefined} className="flex min-h-14 items-start justify-between gap-3 rounded-md px-3 py-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
              <span className="min-w-0 space-y-1"><span className="block font-medium wrap-anywhere">{team.name}</span><span className="block text-xs text-muted-foreground">Team role: {formatRoleLabel(team.teamRole)}{team.isOwner ? " · Owner" : ""}</span></span>
              {activeTeam?.teamId === team.teamId ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-label="Current team" /> : null}
            </Link>
          </li>)}
        </ul>}
        <p ref={countRef} tabIndex={-1} role="status" className="rounded text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{teams.length} teams loaded</p>
        {error ? <Feedback tone="error">{error}</Feedback> : null}
        {nextCursor ? <Button ref={loadButtonRef} type="button" variant="outline" className="w-full" aria-disabled={pending} onClick={loadMore}>{pending ? <><LoaderCircle className="animate-spin" aria-hidden="true" />Loading teams...</> : "Load more teams"}</Button> : null}
        <Button asChild variant="ghost" className="w-full"><Link href="/groups" onClick={() => setOpen(false)}>Open Teams</Link></Button>
      </div>
    </ConfirmationDialog>
  </>;
}
