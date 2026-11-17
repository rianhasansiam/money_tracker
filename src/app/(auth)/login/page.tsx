import { redirect } from "next/navigation";
import Link from "next/link";
import { LockKeyhole, ShieldCheck, WalletCards } from "lucide-react";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { ReauthenticateButton } from "@/components/auth/reauthenticate-button";
import { safeAuthenticationReturn } from "@/lib/auth-return";
import { Separator } from "@/components/ui/separator";
import { Feedback } from "@/components/ui/feedback";
import { auth } from "@/lib/auth";

export const metadata = {
  title: "Sign In",
};

interface LoginPageProps {
  searchParams: Promise<{
    authError?: string | string[];
    retryAfter?: string | string[];
    reference?: string | string[];
    reauth?: string | string[];
    returnTo?: string | string[];
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();
  const query = await searchParams;
  const returnTo = safeAuthenticationReturn(query.returnTo);
  const reauth = query.reauth === "1";

  if (session?.user?.id && !reauth) {
    redirect(returnTo);
  }

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
    <main className="mx-auto grid min-h-screen w-full max-w-6xl items-center gap-10 px-4 py-10 sm:px-8 lg:grid-cols-2 lg:gap-16">
      <section className="space-y-6">
        <Link href="/" className="inline-flex min-h-11 items-center gap-3 rounded-lg font-semibold">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-white"><WalletCards aria-hidden="true" className="h-5 w-5" /></span>
          Money Tracker
        </Link>
        <div className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">Your shared ledger</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Sign in to Money Tracker</h1>
          <p className="max-w-lg text-base leading-7 text-muted-foreground">One clear view of your team’s money. Review the balance, record transactions, and keep the whole team on the same page.</p>
        </div>
        <ul className="space-y-4 text-sm leading-6 text-muted-foreground">
          <li className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" /><span>Your invitation admits your Google account. A team Admin or Moderator separately approves access to each team ledger.</span></li>
          <li className="flex gap-3"><LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" /><span>Your role controls whether you can review the ledger or also record money added and removed.</span></li>
        </ul>
      </section>
      <section className="rounded-xl border border-border bg-card p-6 shadow-xs sm:p-8" aria-labelledby="google-sign-in-title">
        <h2 id="google-sign-in-title" className="text-xl font-semibold">{reauth ? "Sign in again to confirm it is you" : "Continue with your invited account"}</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Use the Google email invited by your administrator. If you need an invitation, contact your workspace administrator.</p>
        <div className="mt-6 space-y-4">
          {authErrorMessage ? <Feedback tone="warning">{authErrorMessage}</Feedback> : null}
          {reauth ? <Feedback tone="warning">Sensitive changes require a Google sign-in within the last 15 minutes. Signing in again revokes older Money Tracker sessions on other devices. You will return to the selected screen and must review and confirm your change again. Unsaved sensitive input is not restored.</Feedback> : null}
          {session?.user?.id ? <ReauthenticateButton returnTo={returnTo} /> : <GoogleSignInButton redirectTo={returnTo} />}
          <Separator className="bg-border" />
          <p className="text-sm leading-6 text-muted-foreground">Google verifies your identity. Your workspace administrator manages access to Money Tracker.</p>
        </div>
      </section>
    </main>
  );
}
