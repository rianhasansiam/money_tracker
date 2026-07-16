import { redirect } from "next/navigation";
import { LockKeyhole, ShieldCheck, TrendingUp } from "lucide-react";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";

export const metadata = {
  title: "Sign In",
};

interface LoginPageProps {
  searchParams: Promise<{
    authError?: string | string[];
    retryAfter?: string | string[];
    reference?: string | string[];
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();

  if (session?.user?.id) {
    redirect("/groups");
  }

  const query = await searchParams;
  const authError =
    typeof query.authError === "string" ? query.authError : null;
  const retryAfterValue =
    typeof query.retryAfter === "string"
      ? Number.parseInt(query.retryAfter, 10)
      : Number.NaN;
  const retryAfter =
    Number.isInteger(retryAfterValue) &&
    retryAfterValue >= 1 &&
    retryAfterValue <= 300
      ? retryAfterValue
      : null;
  const reference =
    typeof query.reference === "string" &&
    /^[0-9a-f-]{36}$/i.test(query.reference)
      ? query.reference
      : null;
  const authErrorMessage =
    authError === "rate_limited"
      ? `Too many sign-in attempts. Try again${
          retryAfter ? ` in ${retryAfter} seconds` : " shortly"
        }.`
      : authError === "unavailable"
        ? `Sign-in protection is temporarily unavailable. Try again later.${
            reference ? ` Reference: ${reference}.` : ""
          }`
        : null;

  return (
    <main className="page-shell min-h-screen px-3 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] w-full max-w-6xl items-center gap-8 lg:grid-cols-[0.94fr_1.06fr]">
        <div className="animate-entry space-y-6 [animation-delay:120ms]">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-3 py-1 text-sm font-medium text-muted-foreground shadow-sm">
            <LockKeyhole className="h-4 w-4 text-primary" />
            Protected team finance workspace
          </div>

          <div className="space-y-4">
            <h1 className="max-w-xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
              Access your invited team workspace with Google.
            </h1>
            <p className="max-w-lg text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
              Sign in with the Google identity provisioned by an administrator,
              then open only the groups and dashboards you are authorized to use.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: TrendingUp,
                title: "Live balance",
                description: "Each approved team sees its own balance and transaction history.",
              },
              {
                icon: ShieldCheck,
                title: "Protected routes",
                description: "Only approved members can open a team dashboard after sign-in.",
              },
              {
                icon: LockKeyhole,
                title: "Permanent history",
                description:
                  "Every transaction is stored in PostgreSQL with the acting team admin or moderator.",
              },
            ].map((item, index) => (
              <Card
                key={item.title}
                className="glass-panel animate-entry border-white/70 bg-white/75"
                style={{ animationDelay: `${240 + index * 70}ms` }}
              >
                <CardContent className="space-y-3 p-5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <CardTitle className="text-base">{item.title}</CardTitle>
                  <CardDescription className="text-sm leading-6">
                    {item.description}
                  </CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <div className="animate-entry [animation-delay:220ms]">
          <div className="glass-panel rounded-4xl border border-white/75 p-4 shadow-[0_30px_90px_rgb(22_38_60_/0.14)] sm:p-6">
            <div className="rounded-3xl bg-white/90 p-6 ring-1 ring-black/5 sm:p-8">
              <div className="space-y-3">
                <p className="text-sm font-semibold tracking-[0.22em] text-muted-foreground uppercase">
                  Welcome back
                </p>
                <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  Sign in to Money Tracker
                </h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  Use the invited Google account associated with this workspace.
                  Unprovisioned identities cannot establish an application session.
                </p>
              </div>

              <div className="mt-8 space-y-4">
                {authErrorMessage ? (
                  <p
                    role="alert"
                    className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"
                  >
                    {authErrorMessage}
                  </p>
                ) : null}
                <GoogleSignInButton redirectTo="/groups" />
                <p className="text-sm leading-6 text-muted-foreground">
                  By continuing, you will authenticate with Google. Access is
                  granted only after server-side admission checks succeed.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
