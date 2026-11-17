"use client";

import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrencyFromMinorUnits } from "@/lib/money";
import type { TransactionTypeValue } from "@/lib/validators/transaction";

interface BalanceCardProps {
  teamName: string;
  canManageTransactions: boolean;
  isSaving: boolean;
  balanceInCents: number;
  totalAddedInCents: number;
  totalRemovedInCents: number;
  onQuickAction: (type: TransactionTypeValue) => void;
}

export function BalanceCard({
  teamName,
  canManageTransactions,
  isSaving,
  balanceInCents,
  totalAddedInCents,
  totalRemovedInCents,
  onQuickAction,
}: BalanceCardProps) {
  return (
    <Card aria-label={`Ledger summary for ${teamName}`} className="min-w-0 overflow-hidden">
      <CardContent className="p-0 sm:p-0 lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="p-5 sm:p-6">
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Wallet className="h-4 w-4 text-primary" aria-hidden="true" />
              <h2>Current team balance</h2>
            </div>
            <p
              data-testid="team-balance"
              className="min-w-0 text-3xl font-semibold tracking-tight wrap-anywhere tabular-nums sm:text-4xl lg:text-5xl"
            >
              {formatCurrencyFromMinorUnits(balanceInCents)}
            </p>
            <p className="text-sm leading-6 text-muted-foreground">
              Whole team ledger · all money added minus all money removed
            </p>
          </div>
        </div>
        <dl className="grid border-t border-border sm:grid-cols-2 lg:items-center lg:border-t-0 lg:pr-4">
          <div className="min-w-0 space-y-2 border-b border-border px-5 py-4 sm:border-r sm:border-b-0 sm:px-6">
            <dt className="flex items-center gap-2 text-sm text-muted-foreground">
              <ArrowUpRight className="h-4 w-4 text-positive" aria-hidden="true" />Total added · all time
            </dt>
            <dd className="text-xl font-semibold wrap-anywhere tabular-nums" data-testid="total-added">
              {formatCurrencyFromMinorUnits(totalAddedInCents)}
            </dd>
          </div>
          <div className="min-w-0 space-y-2 px-5 py-4 sm:px-6">
            <dt className="flex items-center gap-2 text-sm text-muted-foreground">
              <ArrowDownLeft className="h-4 w-4 text-destructive" aria-hidden="true" />Total removed · all time
            </dt>
            <dd className="text-xl font-semibold wrap-anywhere tabular-nums" data-testid="total-removed">
              {formatCurrencyFromMinorUnits(totalRemovedInCents)}
            </dd>
          </div>
        </dl>
        {canManageTransactions ? <div className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:col-span-2"><p className="text-xs leading-5 text-muted-foreground">Record a new entry for this team.</p><div className="grid gap-3 sm:grid-cols-2"><Button type="button" disabled={isSaving} onClick={() => onQuickAction("ADD")}><ArrowUpRight aria-hidden="true" />Add money</Button><Button type="button" variant="outline" disabled={isSaving} onClick={() => onQuickAction("REMOVE")}><ArrowDownLeft aria-hidden="true" />Remove money</Button></div></div> : null}
      </CardContent>
    </Card>
  );
}
