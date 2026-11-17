import type { ReactNode } from "react";
import Link from "next/link";
import { WalletCards } from "lucide-react";
import { cn } from "@/lib/utils";

interface WorkspaceHeaderProps {
  active: "groups" | "dashboard" | "admin";
  title: string;
  description: string;
  canAdmin?: boolean;
  teamId?: string;
  actions?: ReactNode;
  teamSwitcher?: ReactNode;
  globalRole?: string;
}

export function WorkspaceHeader({ active, title, description, canAdmin, teamId, actions, teamSwitcher, globalRole }: WorkspaceHeaderProps) {
  const links = [
    { key: "groups", href: "/groups", label: "Teams" },
    ...(teamId ? [{ key: "dashboard", href: `/dashboard/${teamId}`, label: "Team ledger" }] : []),
    ...(canAdmin ? [{ key: "admin", href: "/admin", label: "Administration" }] : []),
  ];
  return (
    <header className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-3 border-b border-border pb-4">
        <Link href="/groups" className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg text-sm font-semibold min-[380px]:gap-3 min-[380px]:text-base sm:mr-auto">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-white min-[380px]:h-10 min-[380px]:w-10"><WalletCards className="h-5 w-5" aria-hidden="true" /></span>
          Money Tracker
        </Link>
        {teamSwitcher ? <div className="min-w-0 max-w-[48%] sm:max-w-72">{teamSwitcher}</div> : null}
        <nav aria-label="Workspace" className="flex basis-full flex-wrap gap-1 sm:basis-auto">
          {links.map((link) => (
            <Link key={link.key} href={link.href} aria-current={active === link.key ? "page" : undefined}
              className={cn("inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors", active === link.key ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">{active === "dashboard" ? "Team workspace" : active === "admin" ? "Administration" : "Your workspace"}</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {actions || globalRole ? <div className="flex shrink-0 flex-wrap items-center gap-3">{globalRole ? <p className="text-xs text-muted-foreground">Global role: {globalRole === "ADMIN" ? "Admin" : globalRole === "MODERATOR" ? "Moderator" : "Member"}</p> : null}{actions}</div> : null}
      </div>
    </header>
  );
}
