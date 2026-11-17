import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page-shell flex min-h-screen items-center justify-center px-4 py-10">
      <section
        className="w-full max-w-xl rounded-xl border border-border bg-card p-6 text-center sm:p-8"
        aria-labelledby="not-found-title"
      >
        <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Page not found
        </p>
        <h1
          id="not-found-title"
          className="mt-3 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
        >
          That page is not available
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground sm:text-base">
          Check the address, or return to a safe starting point. No account or
          team details are shown here.
        </p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-sm transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Return home
          </Link>
          <Link
            href="/login"
            className="inline-flex h-11 items-center justify-center rounded-lg border border-border bg-card px-6 text-sm font-semibold text-foreground transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Go to sign in
          </Link>
        </div>
      </section>
    </main>
  );
}

