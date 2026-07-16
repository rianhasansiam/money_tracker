"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";

interface DashboardErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function DashboardError({
  error,
  unstable_retry,
}: DashboardErrorProps) {
  void error;

  return (
    <RecoveryPanel
      title="The dashboard could not be loaded"
      description="No transaction was created or changed. Retry the dashboard, or return to your groups."
      onRetry={unstable_retry}
      backHref="/groups"
      backLabel="Return to groups"
    />
  );
}

