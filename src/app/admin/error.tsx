"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";

interface AdminErrorProps {
  error: unknown;
  retry: () => void;
}

export default function AdminError({ error, retry }: AdminErrorProps) {
  void error;

  return (
    <RecoveryPanel
      title="The administrative console could not be loaded"
      description="Reload the console to check the current state before repeating an administrative change."
      onRetry={retry}
      backHref="/groups"
      backLabel="Return to Teams"
    />
  );
}
