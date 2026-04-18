"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { approveTeamAccess } from "@/actions/groups";
import { Button } from "@/components/ui/button";

interface ApproveRequestButtonProps {
  membershipId: string;
}

export function ApproveRequestButton({
  membershipId,
}: ApproveRequestButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      className="w-full sm:w-auto"
      onClick={() => {
        startTransition(async () => {
          const result = await approveTeamAccess(membershipId);

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
      {isPending ? "Approving..." : "Approve request"}
    </Button>
  );
}
