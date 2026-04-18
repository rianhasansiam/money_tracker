"use client";

import { useState } from "react";
import { Lock, Sparkles } from "lucide-react";
import { BalanceCard } from "@/components/dashboard/balance-card";
import { TransactionForm } from "@/components/dashboard/transaction-form";
import { TransactionList } from "@/components/dashboard/transaction-list";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import type { DashboardTransaction } from "@/lib/queries/dashboard";
import type { TeamMembershipRoleValue } from "@/lib/queries/groups";
import { formatRoleLabel } from "@/lib/roles";
import type { TransactionTypeValue } from "@/lib/validators/transaction";

interface DashboardShellProps {
  teamId: string;
  teamName: string;
  viewerRole: TeamMembershipRoleValue;
  canManageTransactions: boolean;
  balanceInCents: number;
  totalAddedInCents: number;
  totalRemovedInCents: number;
  transactions: DashboardTransaction[];
}

export function DashboardShell({
  teamId,
  teamName,
  viewerRole,
  canManageTransactions,
  balanceInCents,
  totalAddedInCents,
  totalRemovedInCents,
  transactions,
}: DashboardShellProps) {
  const [preferredType, setPreferredType] =
    useState<TransactionTypeValue>("ADD");
  const roleLabel = formatRoleLabel(viewerRole);

  return (
    <section className="space-y-6">
      <BalanceCard
        teamName={teamName}
        canManageTransactions={canManageTransactions}
        balanceInCents={balanceInCents}
        totalAddedInCents={totalAddedInCents}
        totalRemovedInCents={totalRemovedInCents}
        onQuickAction={setPreferredType}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_24rem]">
        <div className="order-2 space-y-6 xl:order-1">
          <TransactionList transactions={transactions} />
        </div>

        <aside className="order-1 space-y-6 xl:order-2 xl:sticky xl:top-6 xl:self-start">
          {canManageTransactions ? (
            <TransactionForm
              teamId={teamId}
              preferredType={preferredType}
              onPreferredTypeChange={setPreferredType}
            />
          ) : (
            <Card className="glass-panel animate-entry border-white/75 bg-white/82 [animation-delay:180ms]">
              <CardContent className="space-y-4 p-5 sm:p-6">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                    <Lock className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-base">View-only access</CardTitle>
                    <CardDescription className="mt-1 text-sm leading-6">
                      Your current role for this team is {roleLabel}. Members can
                      review balances and history, but only admins and modaretors
                      can save transactions.
                    </CardDescription>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/70 bg-muted/45 p-4">
                  <p className="text-sm leading-6 text-muted-foreground">
                    If a team manager changes your membership role from Member to
                    Admin or Modaretor in the database, the transaction form will
                    unlock the next time you load this dashboard.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="glass-panel animate-entry border-white/70 bg-white/80 [animation-delay:260ms]">
            <CardContent className="space-y-4 p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                  <Lock className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-base">Team-aware permissions</CardTitle>
                  <CardDescription className="mt-1 text-sm leading-6">
                    Approved members of this group can view the dashboard, while
                    only admins and modaretors can add or remove money.
                  </CardDescription>
                </div>
              </div>

              <div className="rounded-2xl border border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(247,243,235,0.94))] p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Nice workflow tip
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  The quick action buttons above preset the form, so you can jump
                  straight into the next shared team add or remove flow.
                </p>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </section>
  );
}
