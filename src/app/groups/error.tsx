"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";

interface GroupsErrorProps {
  error: unknown;
  retry: () => void;
}

export default function GroupsError({
  error,
  retry,
}: GroupsErrorProps) {
  void error;

  return (
    <RecoveryPanel
      title="Your teams could not be loaded"
      description="Try loading your teams again. Check the current membership state before repeating an action."
      onRetry={retry}
      backHref="/"
      backLabel="Return home"
    />
  );
}

