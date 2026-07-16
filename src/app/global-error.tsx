"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";
import "./globals.css";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function GlobalError({
  error,
  unstable_retry,
}: GlobalErrorProps) {
  void error;

  return (
    <html lang="en">
      <body className="min-h-full bg-background font-sans text-foreground antialiased">
        <title>Unable to load | Money Tracker</title>
        <RecoveryPanel
          title="Money Tracker is temporarily unavailable"
          description="Your financial data has not been displayed or changed. Try again, or return to the home page."
          onRetry={unstable_retry}
          backHref="/"
          backLabel="Return home"
        />
      </body>
    </html>
  );
}

