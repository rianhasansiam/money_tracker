"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";

interface DashboardErrorProps {
  error: unknown;
  retry: () => void;
}

export default function DashboardError({
  error,
  retry,
}: DashboardErrorProps) {
  void error;

  return (
    <RecoveryPanel
      title="The dashboard could not be loaded"
      description="Retry loading the ledger, or return to Teams. If you were saving an entry, check the history before repeating it."
      onRetry={retry}
      backHref="/groups"
      backLabel="Return to Teams"
    />
  );
}

