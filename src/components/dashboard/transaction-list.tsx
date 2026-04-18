import { ArrowDownLeft, ArrowUpRight, Clock3 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  formatCurrencyFromMinorUnits,
  formatSignedCurrency,
  formatTransactionDate,
} from "@/lib/money";
import type { DashboardTransaction } from "@/lib/queries/dashboard";

interface TransactionListProps {
  transactions: DashboardTransaction[];
}

export function TransactionList({ transactions }: TransactionListProps) {
  return (
    <Card className="glass-panel animate-entry border-white/75 bg-white/82 [animation-delay:220ms]">
      <CardHeader className="space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-xl">Transaction history</CardTitle>
          <span className="inline-flex w-fit items-center rounded-full bg-muted/70 px-3 py-1 text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            {transactions.length} entries
          </span>
        </div>
        <CardDescription>
          Latest transactions appear first and every record is stored
          permanently for the shared team ledger with admin attribution.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {transactions.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border/80 bg-muted/55 px-5 py-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Clock3 className="h-5 w-5" />
            </div>
            <p className="mt-4 text-lg font-medium text-foreground">
              No transactions yet
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              The shared ledger will start filling up here as soon as an admin
              or modaretor adds or removes money from the form.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {transactions.map((transaction, index) => {
              const isAdd = transaction.type === "ADD";

              return (
                <div key={transaction.id}>
                  <div className="rounded-3xl border border-white/75 bg-white/78 p-4 shadow-sm">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 gap-3 sm:gap-4">
                        <div
                          className={
                            isAdd
                              ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"
                              : "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-700"
                          }
                        >
                          {isAdd ? (
                            <ArrowUpRight className="h-5 w-5" />
                          ) : (
                            <ArrowDownLeft className="h-5 w-5" />
                          )}
                        </div>

                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-foreground">
                              {isAdd ? "Money added" : "Money removed"}
                            </p>
                            <span
                              className={
                                isAdd
                                  ? "rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700"
                                  : "rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700"
                              }
                            >
                              {transaction.type}
                            </span>
                          </div>
                          <p className="wrap-break-word text-sm leading-6 text-muted-foreground">
                            {transaction.note || "No note provided for this transaction."}
                          </p>
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            <p className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase sm:text-xs sm:tracking-[0.16em]">
                              {formatTransactionDate(transaction.transactionDate)}
                            </p>
                            <p className="wrap-break-word text-sm text-muted-foreground">
                              Performed by{" "}
                              <span className="font-medium text-foreground">
                                {transaction.createdByName ||
                                  transaction.createdByEmail ||
                                  "Unknown admin"}
                              </span>
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl bg-muted/45 px-3 py-2 sm:min-w-40 sm:bg-transparent sm:px-0 sm:py-0 sm:text-right">
                        <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase sm:hidden">
                          Amount
                        </p>
                        <p
                          className={
                            isAdd
                              ? "mt-1 text-lg font-semibold text-emerald-700 sm:mt-0"
                              : "mt-1 text-lg font-semibold text-amber-700 sm:mt-0"
                          }
                        >
                          {formatSignedCurrency(
                            transaction.amountInCents,
                            transaction.type,
                          )}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Stored as {formatCurrencyFromMinorUnits(transaction.amountInCents)}
                        </p>
                      </div>
                    </div>
                  </div>

                  {index !== transactions.length - 1 ? (
                    <Separator className="my-4 bg-border/60" />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
