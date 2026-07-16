import { WalletCards } from "lucide-react";

interface LoadingPanelProps {
  label?: string;
}

export function LoadingPanel({ label = "Loading Money Tracker" }: LoadingPanelProps) {
  return (
    <main
      className="page-shell flex min-h-screen items-center justify-center px-4 py-10"
      aria-busy="true"
    >
      <section
        className="glass-panel animate-entry w-full max-w-md rounded-[2rem] border border-white/75 px-6 py-9 text-center sm:px-10 sm:py-11"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="relative mx-auto h-16 w-16" aria-hidden="true">
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-primary/15 border-t-primary motion-reduce:animate-none" />
          <div className="absolute inset-2 flex items-center justify-center rounded-full bg-primary/12 text-primary shadow-sm">
            <WalletCards className="h-6 w-6" strokeWidth={1.8} />
          </div>
        </div>

        <p className="mt-6 text-lg font-semibold tracking-tight text-foreground">
          {label}
        </p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Preparing a secure view of your latest data.
        </p>

        <div className="mx-auto mt-7 w-full max-w-xs space-y-2.5" aria-hidden="true">
          <div className="h-2.5 animate-pulse rounded-full bg-primary/15 motion-reduce:animate-none" />
          <div className="mx-auto h-2.5 w-4/5 animate-pulse rounded-full bg-primary/10 [animation-delay:150ms] motion-reduce:animate-none" />
          <div className="mx-auto h-2.5 w-3/5 animate-pulse rounded-full bg-primary/10 [animation-delay:300ms] motion-reduce:animate-none" />
        </div>
      </section>
    </main>
  );
}
