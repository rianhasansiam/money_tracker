"use client";

import { Button } from "@/components/ui/button";

interface RecoveryPanelProps {
  backHref: string;
  backLabel: string;
  description: string;
  onRetry: () => void;
  title: string;
}

export function RecoveryPanel({
  backHref,
  backLabel,
  description,
  onRetry,
  title,
}: RecoveryPanelProps) {
  return (
    <main className="page-shell flex min-h-screen items-center justify-center px-4 py-10">
      <section
        className="w-full max-w-xl rounded-xl border border-border bg-card p-6 text-center sm:p-8"
        role="alert"
        aria-labelledby="recovery-title"
      >
        <p className="text-xs font-semibold tracking-[0.18em] text-destructive uppercase">
          Temporary problem
        </p>
        <h1
          id="recovery-title"
          className="mt-3 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
        >
          {title}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground sm:text-base">
          {description}
        </p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <Button type="button" onClick={onRetry}>Try again</Button>
          <Button asChild variant="outline"><a href={backHref}>{backLabel}</a></Button>
        </div>
      </section>
    </main>
  );
}

