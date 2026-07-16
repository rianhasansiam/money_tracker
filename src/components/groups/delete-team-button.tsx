"use client";

import { useState, useTransition } from "react";
import { ArchiveX, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { quarantineTeamAction } from "@/actions/groups";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DeleteTeamButtonProps {
  teamId: string;
  teamName: string;
}

export function DeleteTeamButton({
  teamId,
  teamName,
}: DeleteTeamButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  function closeDialog() {
    if (isPending) {
      return;
    }

    setIsOpen(false);
    setConfirmation("");
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full border-destructive/25 text-destructive hover:bg-destructive/5 hover:text-destructive sm:w-auto"
        onClick={() => setIsOpen(true)}
      >
        <ArchiveX className="h-4 w-4" />
        Quarantine group
      </Button>

      {isOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"
          role="presentation"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeDialog();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={`quarantine-title-${teamId}`}
            aria-describedby={`quarantine-description-${teamId}`}
            className="w-full max-w-lg rounded-3xl border border-white/70 bg-white p-5 shadow-2xl sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2
                  id={`quarantine-title-${teamId}`}
                  className="text-xl font-semibold text-foreground"
                >
                  Quarantine {teamName}?
                </h2>
                <p
                  id={`quarantine-description-${teamId}`}
                  className="mt-2 text-sm leading-6 text-muted-foreground"
                >
                  Normal access will stop immediately. Memberships and the full
                  financial ledger remain preserved for 30 days and an admin can
                  restore the team during that window.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close quarantine confirmation"
                onClick={closeDialog}
                disabled={isPending}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="mt-5 space-y-2">
              <Label htmlFor={`confirm-team-${teamId}`}>
                Type <span className="font-semibold">{teamName}</span> exactly
              </Label>
              <Input
                id={`confirm-team-${teamId}`}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                autoFocus
                disabled={isPending}
              />
            </div>

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                disabled={isPending}
              >
                Keep group
              </Button>
              <Button
                type="button"
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={isPending || confirmation !== teamName}
                onClick={() => {
                  startTransition(async () => {
                    try {
                      const result = await quarantineTeamAction(
                        teamId,
                        confirmation,
                      );

                      if (result.status === "error") {
                        toast.error(result.message);
                        return;
                      }

                      toast.success(result.message);
                      setIsOpen(false);
                      setConfirmation("");
                      router.refresh();
                    } catch {
                      toast.error(
                        "We could not confirm whether this group changed. Refresh the page before taking another action.",
                      );
                    }
                  });
                }}
              >
                <ArchiveX className="h-4 w-4" />
                {isPending ? "Quarantining..." : "Quarantine for 30 days"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
