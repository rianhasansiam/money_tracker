import Link from "next/link";
import { ArrowRight, ShieldCheck, Sparkles, WalletCards } from "lucide-react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { formatCurrencyFromMinorUnits } from "@/lib/money";

const showcaseTransactions = [
  {
    label: "Salary deposit",
    amountInCents: 8500000,
    note: "Monthly income cleared",
  },
  {
    label: "Studio rent",
    amountInCents: -2200000,
    note: "Auto-tagged as spending",
  },
  {
    label: "Emergency fund",
    amountInCents: 1250000,
    note: "Protected savings transfer",
  },
];

export default async function HomePage() {
  const session = await auth();

  return (
    <main className="page-shell min-h-screen px-3 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-7xl flex-col">
        <header className="animate-entry flex flex-col gap-4 rounded-3xl border border-white/70 bg-white/70 px-4 py-4 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:rounded-full md:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary shadow-sm">
              <WalletCards className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Money Tracker
              </p>
              <p className="text-sm text-foreground/80">
                Shared cashflow, kept simple.
              </p>
            </div>
          </div>

          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            {session?.user?.id ? (
              <>
                <Button asChild variant="secondary" className="w-full sm:w-auto">
                  <Link href="/groups">Open Groups</Link>
                </Button>
                <SignOutButton className="w-full sm:w-auto" buttonClassName="w-full" />
              </>
            ) : (
              <Button asChild className="w-full sm:w-auto">
                <Link href="/login">
                  Continue with Google
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            )}
          </div>
        </header>

        <section className="grid flex-1 items-center gap-8 py-10 lg:grid-cols-[1.12fr_0.88fr] lg:py-14">
          <div className="animate-entry space-y-6 sm:space-y-8 [animation-delay:120ms]">
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/70 bg-white/80 px-3 py-1 text-sm font-medium text-muted-foreground shadow-sm">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="whitespace-normal">
                Google login, team-specific dashboards, request-and-approve membership
              </span>
            </div>

            <div className="space-y-5">
              <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl lg:text-6xl">
                Give your team one shared money dashboard that stays calm, fast,
                and trustworthy.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
                Let each team keep its own balance, transaction history, and
                approval flow while members, modaretors, and admins see the
                right controls for their role.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="sm:min-w-48">
                <Link href={session?.user?.id ? "/groups" : "/login"}>
                  {session?.user?.id ? "Open groups" : "Start with Google"}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="sm:min-w-48">
                <Link href={session?.user?.id ? "/groups" : "/login"}>
                  {session?.user?.id ? "Manage memberships" : "Team sign-in"}
                </Link>
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  title: "Team-specific dashboards",
                  description: "Each approved team member sees only the dashboard for their own groups.",
                },
                {
                  title: "Member, modaretor, admin roles",
                  description:
                    "Members can view dashboards, while admins and modaretors control transactions.",
                },
                {
                  title: "Ready to deploy",
                  description: "Next.js App Router, Prisma, Auth.js, and Tailwind 4.",
                },
              ].map((item, index) => (
                <Card
                  key={item.title}
                  className="glass-panel animate-entry border-white/70 bg-white/75"
                  style={{ animationDelay: `${220 + index * 80}ms` }}
                >
                  <CardContent className="space-y-2 p-5">
                    <CardTitle className="text-base">{item.title}</CardTitle>
                    <CardDescription className="text-sm leading-6">
                      {item.description}
                    </CardDescription>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <div className="animate-entry [animation-delay:240ms]">
            <div className="glass-panel rounded-4xl border border-white/75 p-4 shadow-[0_30px_90px_rgb(22_38_60_/0.14)] sm:p-6">
              <div className="rounded-3xl bg-[linear-gradient(145deg,rgba(255,255,255,0.92),rgba(249,245,236,0.92))] p-5 ring-1 ring-black/5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-muted-foreground">
                      Available balance
                    </p>
                    <p className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                      {formatCurrencyFromMinorUnits(7550000)}
                    </p>
                  </div>
                  <div className="rounded-full bg-primary/12 p-3 text-primary">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-primary/10 p-4 text-primary-foreground/90">
                    <p className="text-xs font-semibold tracking-[0.2em] text-primary uppercase">
                      Inflow
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">
                      {formatCurrencyFromMinorUnits(9750000)}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-amber-100/80 p-4">
                    <p className="text-xs font-semibold tracking-[0.2em] text-amber-700 uppercase">
                      Outflow
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">
                      {formatCurrencyFromMinorUnits(2200000)}
                    </p>
                  </div>
                </div>

                <div className="mt-6 space-y-3">
                  {showcaseTransactions.map((item) => {
                    const isPositive = item.amountInCents >= 0;

                    return (
                      <div
                        key={item.label}
                        className="flex flex-col gap-2 rounded-2xl border border-white/80 bg-white/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="wrap-break-word font-medium text-foreground">
                            {item.label}
                          </p>
                          <p className="wrap-break-word text-sm text-muted-foreground">
                            {item.note}
                          </p>
                        </div>
                        <p
                          className={
                            isPositive
                              ? "font-semibold text-primary"
                              : "font-semibold text-amber-700"
                          }
                        >
                          {isPositive ? "+" : "-"}
                          {formatCurrencyFromMinorUnits(
                            Math.abs(item.amountInCents),
                          )}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
