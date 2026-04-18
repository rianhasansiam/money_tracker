"use client";

import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { formatCurrencyFromMinorUnits } from "@/lib/money";
import type { TransactionTypeValue } from "@/lib/validators/transaction";

interface BalanceCardProps {
  teamName: string;
  canManageTransactions: boolean;
  balanceInCents: number;
  totalAddedInCents: number;
  totalRemovedInCents: number;
  onQuickAction: (type: TransactionTypeValue) => void;
}

export function BalanceCard({
  teamName,
  canManageTransactions,
  balanceInCents,
  totalAddedInCents,
  totalRemovedInCents,
  onQuickAction,
}: BalanceCardProps) {
  function handleQuickAction(type: TransactionTypeValue) {
    onQuickAction(type);
    document.getElementById("transaction-form")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  return (
    <Card className="glass-panel animate-entry overflow-hidden border-white/75 bg-white/80 [animation-delay:120ms]">
      <CardContent className="p-0">
        <div className="border-b border-white/70 bg-[linear-gradient(135deg,rgba(33,186,157,0.16),rgba(255,214,128,0.22))] p-5 sm:p-7">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/75 text-primary shadow-sm">
                  <Wallet className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                    Team balance
                  </p>
                  <CardDescription className="mt-1 text-sm leading-6">
                    {teamName} ledger shared across approved team members
                  </CardDescription>
                </div>
              </div>

              <div>
                <CardTitle className="text-2xl font-semibold tracking-tight min-[380px]:text-3xl sm:text-5xl">
                  {formatCurrencyFromMinorUnits(balanceInCents)}
                </CardTitle>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  The team balance is always total added money minus total
                  removed money.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                type="button"
                onClick={() => handleQuickAction("ADD")}
                className="w-full sm:min-w-44"
                disabled={!canManageTransactions}
              >
                <ArrowUpRight className="h-4 w-4" />
                Add money
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleQuickAction("REMOVE")}
                className="w-full border-amber-200 bg-white/70 text-amber-900 hover:bg-amber-50 sm:min-w-44"
                disabled={!canManageTransactions}
              >
                <ArrowDownLeft className="h-4 w-4" />
                Remove money
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-7">
          <div className="rounded-3xl border border-emerald-100 bg-emerald-50/80 p-5">
            <p className="text-xs font-semibold tracking-[0.2em] text-emerald-700 uppercase">
              Total added
            </p>
            <p className="mt-3 text-2xl font-semibold text-foreground">
              {formatCurrencyFromMinorUnits(totalAddedInCents)}
            </p>
          </div>
          <div className="rounded-3xl border border-amber-100 bg-amber-50/80 p-5">
            <p className="text-xs font-semibold tracking-[0.2em] text-amber-700 uppercase">
              Total removed
            </p>
            <p className="mt-3 text-2xl font-semibold text-foreground">
              {formatCurrencyFromMinorUnits(totalRemovedInCents)}
            </p>
          </div>
        </div>

        {!canManageTransactions ? (
          <div className="border-t border-white/70 bg-white/70 px-5 py-4 sm:px-7">
            <p className="text-sm leading-6 text-muted-foreground">
              You can review this team balance on any device, but only team
              admins and modaretors can add or remove money.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
