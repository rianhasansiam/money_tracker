"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { ArchiveX } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { quarantineTeamAction } from "@/actions/groups";
import { ReauthenticateButton } from "@/components/auth/reauthenticate-button";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Feedback } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DeleteTeamButton({ teamId, teamName, returnTo = "/groups" }: { teamId: string; teamName: string; returnTo?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  function closeDialog() {
    if (submitting.current) return;
    setIsOpen(false); setConfirmation(""); setError(null); setNeedsSignIn(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || confirmation !== teamName) return;
    submitting.current = true; setError(null);
    startTransition(async () => {
      try {
        const result = await quarantineTeamAction(teamId, confirmation);
        if (result.status === "error") { setError(result.message); setNeedsSignIn(result.code === "RECENT_AUTHENTICATION_REQUIRED"); return; }
        toast.success(result.message);
        setIsOpen(false); setConfirmation(""); router.refresh();
      } catch {
        setError("We could not confirm whether the team changed. Refresh the page before trying again.");
      } finally { submitting.current = false; }
    });
  }

  return <>
    <Button type="button" variant="outline" className="w-full border-destructive/30 text-destructive hover:bg-red-50 sm:w-auto" onClick={() => setIsOpen(true)}>
      <ArchiveX aria-hidden="true" /> Quarantine team
    </Button>
    <ConfirmationDialog open={isOpen} busy={isPending} onClose={closeDialog} title={`Quarantine ${teamName}?`}
      description="Normal access will stop. The ledger and memberships are preserved, and administrators can restore the team during the 30-day recovery period. This action does not permanently delete the team.">
      <form onSubmit={submit} className="mt-5 space-y-5" aria-busy={isPending}>
        <div className="space-y-2">
          <Label htmlFor={`confirm-team-${teamId}`}>Type <span className="font-semibold">{teamName}</span> exactly</Label>
          <Input id={`confirm-team-${teamId}`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" autoFocus disabled={isPending} />
        </div>
        {error ? <Feedback tone="error">{error}</Feedback> : null}
        <p className="text-sm leading-6 text-muted-foreground">The recovery period starts after confirmation. Permanent removal requires a separate administrator operation after retention.</p>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={closeDialog} disabled={isPending}>Keep team</Button>
          <Button type="submit" className="bg-destructive text-white hover:bg-destructive/90" disabled={isPending || confirmation !== teamName}>
            <ArchiveX aria-hidden="true" />{isPending ? "Quarantining..." : "Quarantine for 30 days"}
          </Button>
        </div>
      </form>
        {needsSignIn ? <div className="space-y-2"><p className="text-sm leading-6 text-muted-foreground">Sign in again to confirm your identity. A new Google sign-in revokes older application sessions. You will need to enter the team name and confirm this action again; this confirmation is not restored or automatically submitted.</p><ReauthenticateButton returnTo={returnTo} /></div> : null}
    </ConfirmationDialog>
  </>;
}
