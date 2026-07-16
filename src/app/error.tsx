"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";

interface ApplicationErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function ApplicationError({
  error,
  unstable_retry,
}: ApplicationErrorProps) {
  void error;

  return (
    <RecoveryPanel
      title="We could not load this page"
      description="No data was changed. Try the request again, or return to the home page."
      onRetry={unstable_retry}
      backHref="/"
      backLabel="Return home"
    />
  );
}

