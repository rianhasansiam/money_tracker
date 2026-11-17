import Link from "next/link";
import { ArrowRight, BookOpen, ShieldCheck, Users, WalletCards } from "lucide-react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";

export default async function HomePage() {
  const session = await auth();
  const destination = session?.user?.id ? "/groups" : "/login";
  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <Link href="/" className="inline-flex min-h-11 items-center gap-3 rounded-lg font-semibold"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-white"><WalletCards className="h-5 w-5" aria-hidden="true" /></span>Money Tracker</Link>
        {session?.user?.id ? <SignOutButton /> : <Button asChild variant="outline"><Link href="/login">Sign in</Link></Button>}
      </header>
      <section className="max-w-3xl py-16 sm:py-24">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Team money, clearly recorded</p>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">A shared ledger everyone on your team can understand.</h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">Keep your team’s BDT balance and transaction history in one place. Approved members can review the ledger; team managers can record money added and removed.</p>
        <Button asChild size="lg" className="mt-8"><Link href={destination}>{session?.user?.id ? "Open Teams" : "Continue with Google"}<ArrowRight aria-hidden="true" /></Link></Button>
      </section>
      <section className="grid gap-6 border-t border-border py-8 md:grid-cols-3" aria-label="Workspace features">
        {[{icon:Users,title:"Teams with clear access",copy:"Request membership and open only the teams you are approved to join."},{icon:BookOpen,title:"A lasting transaction record",copy:"Review dated entries, signed amounts and who recorded them."},{icon:ShieldCheck,title:"Protected administration",copy:"Invitations, membership approvals and recoverable quarantine keep access deliberate."}].map(({icon:Icon,title,copy}) => <div key={title} className="space-y-3"><Icon className="h-5 w-5 text-primary" aria-hidden="true" /><h2 className="text-base font-semibold">{title}</h2><p className="text-sm leading-6 text-muted-foreground">{copy}</p></div>)}
      </section>
    </main>
  );
}
