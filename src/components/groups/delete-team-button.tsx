"use client";

import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deleteTeam } from "@/actions/groups";
import { Button } from "@/components/ui/button";

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

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full border-destructive/25 text-destructive hover:bg-destructive/5 hover:text-destructive sm:w-auto"
      onClick={() => {
        const shouldDelete = window.confirm(
          `Delete ${teamName}? This will permanently remove the group, its memberships, and its transactions.`,
        );

        if (!shouldDelete) {
          return;
        }

        startTransition(async () => {
          const result = await deleteTeam(teamId);

          if (result.status === "error") {
            toast.error(result.message);
            return;
          }

          toast.success(result.message);
          router.refresh();
        });
      }}
      disabled={isPending}
    >
      <Trash2 className="h-4 w-4" />
      {isPending ? "Deleting..." : "Delete group"}
    </Button>
  );
}
