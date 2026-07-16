"use client";

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
        className="glass-panel w-full max-w-xl rounded-3xl border border-white/75 p-6 text-center sm:p-9"
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
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-sm transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Try again
          </button>
          <a
            href={backHref}
            className="inline-flex h-11 items-center justify-center rounded-full border border-border bg-white/80 px-6 text-sm font-semibold text-foreground transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {backLabel}
          </a>
        </div>
      </section>
    </main>
  );
}

