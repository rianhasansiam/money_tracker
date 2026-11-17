"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { requestTeamAccess } from "@/actions/groups";
import { Button } from "@/components/ui/button";

interface RequestAccessButtonProps {
  teamId: string;
}

export function RequestAccessButton({ teamId, requestsHref }: RequestAccessButtonProps & { requestsHref?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      className="w-full sm:w-auto"
      onClick={() => {
        startTransition(async () => {
          try {
            const result = await requestTeamAccess(teamId);

            if (result.status === "error") {
              toast.error(result.message);
              return;
            }

            toast.success(result.message);
            if (requestsHref?.startsWith("/groups?")) router.push(requestsHref);
            router.refresh();
          } catch {
            toast.error(
              "We could not confirm the join request. Refresh the page before trying again.",
            );
          }
        });
      }}
      disabled={isPending}
    >
      {isPending ? "Sending..." : "Request to join"}
    </Button>
  );
}
