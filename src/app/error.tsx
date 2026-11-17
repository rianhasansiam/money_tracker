"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";

interface ApplicationErrorProps {
  error: unknown;
  retry: () => void;
}

export default function ApplicationError({
  error,
  retry,
}: ApplicationErrorProps) {
  void error;

  return (
    <RecoveryPanel
      title="We could not load this page"
      description="Try loading this view again, or return to the home page."
      onRetry={retry}
      backHref="/"
      backLabel="Return home"
    />
  );
}

