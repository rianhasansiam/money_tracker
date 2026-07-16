"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";

interface GroupsErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function GroupsError({
  error,
  unstable_retry,
}: GroupsErrorProps) {
  void error;

  return (
    <RecoveryPanel
      title="Your groups could not be loaded"
      description="No membership or team data was changed. Try again, or return to the home page."
      onRetry={unstable_retry}
      backHref="/"
      backLabel="Return home"
    />
  );
}

