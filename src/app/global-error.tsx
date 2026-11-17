"use client";

import { RecoveryPanel } from "@/components/system/recovery-panel";
import "./globals.css";

interface GlobalErrorProps {
  error: unknown;
  retry: () => void;
}

export default function GlobalError({
  error,
  retry,
}: GlobalErrorProps) {
  void error;

  return (
    <html lang="en">
      <body className="min-h-full bg-background font-sans text-foreground antialiased">
        <title>Unable to load | Money Tracker</title>
        <RecoveryPanel
          title="Money Tracker is temporarily unavailable"
          description="Try loading the workspace again, or return to the home page. If you were saving an entry, check the ledger before repeating it."
          onRetry={retry}
          backHref="/"
          backLabel="Return home"
        />
      </body>
    </html>
  );
}

