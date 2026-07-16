"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";

interface AdminErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function AdminError({ error, unstable_retry }: AdminErrorProps) {
  void error;

  return (
    <RecoveryPanel
      title="The administrative console could not be loaded"
      description="No administrative change was made. Try again, or return to the groups page."
      onRetry={unstable_retry}
      backHref="/groups"
      backLabel="Return to groups"
    />
  );
}
