"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowDownLeft, ArrowUpRight, Clock3, LoaderCircle } from "lucide-react";
import { loadMoreTransactionHistory } from "@/actions/dashboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatTransactionDateOnly } from "@/lib/date-time";
import { formatSignedCurrency } from "@/lib/money";
import type { HistoryFilters } from "@/lib/history-filters";
import type { DashboardTransactionDto, TransactionHistoryPageDto } from "@/lib/queries/dashboard";

interface TransactionListProps {
  snapshotRevision: string;
  teamId: string;
  initialPage: TransactionHistoryPageDto;
  filters: HistoryFilters;
  ledgerHasTransactions: boolean;
  onSnapshotChanged: () => void;
}

function Direction({ type }: { type: DashboardTransactionDto["type"] }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium ${type === "ADD" ? "text-positive" : "text-destructive"}`}>
      {type === "ADD" ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : <ArrowDownLeft className="h-4 w-4" aria-hidden="true" />}
      {type === "ADD" ? "Added" : "Removed"}
    </span>
  );
}

export function TransactionList({ snapshotRevision, teamId, initialPage, filters, ledgerHasTransactions, onSnapshotChanged }: TransactionListProps) {
  const [transactions, setTransactions] = useState(initialPage.transactions);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const paginationButtonRef = useRef<HTMLButtonElement>(null);
  const completionRef = useRef<HTMLParagraphElement>(null);
  const focusCompletionRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (nextCursor === null && focusCompletionRef.current) {
      focusCompletionRef.current = false;
      completionRef.current?.focus({ preventScroll: true });
    }
  }, [nextCursor]);

  function loadNextPage() {
    if (!nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    const request = ++requestRef.current;
    const currentRequest = () => mountedRef.current && requestRef.current === request;
    startTransition(async () => {
      try {
        // Next Server Actions do not expose AbortSignal. A viewer/team/revision
        // remount invalidates this request before any result can enter state.
        const result = await loadMoreTransactionHistory(teamId, nextCursor, snapshotRevision, filters);
        if (!currentRequest()) return;
        if (result.status === "error") {
          setErrorMessage(result.message);
          if (result.code === "SNAPSHOT_CHANGED") onSnapshotChanged();
          return;
        }
        // Keep a keyboard user's place when the last page removes its button.
        // If they moved elsewhere while waiting, leave that focus untouched.
        focusCompletionRef.current = result.page.nextCursor === null &&
          document.activeElement === paginationButtonRef.current;
        setTransactions((currentTransactions) => {
          const existingIds = new Set(currentTransactions.map((transaction) => transaction.id));
          const unseen = result.page.transactions.filter((transaction) => {
            if (existingIds.has(transaction.id)) return false;
            existingIds.add(transaction.id);
            return true;
          });
          return [...currentTransactions, ...unseen];
        });
        setNextCursor(result.page.nextCursor);
        setErrorMessage(null);
      } catch {
        if (currentRequest()) setErrorMessage("We could not load more history. Wait a moment and try again.");
      } finally {
        if (currentRequest()) loadingRef.current = false;
      }
    });
  }

  return (
    <Card className="min-w-0" aria-labelledby="history-heading">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="history-heading" className="text-lg font-semibold">Transaction history</h2>
          <span role="status" className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground tabular-nums">{transactions.length} loaded</span>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">Newest transaction date first. Loaded entries are part of the full team ledger.</p>
      </CardHeader>
      <CardContent>
        {transactions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-center">
            <Clock3 className="mx-auto mb-3 h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <h3 className="font-semibold">{ledgerHasTransactions ? "No matching transactions" : "No transactions yet"}</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{ledgerHasTransactions ? "Try another note, money direction, or date range. Clear filters above to return to the full history." : "A team Admin or Moderator can record the first addition or removal. Saved entries will appear here."}</p>
          </div>
        ) : (
          <>
            <div className="hidden max-w-full overflow-x-auto rounded-lg border border-border lg:block">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Team transactions, newest transaction date first</caption>
                <thead className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
                  <tr><th scope="col" className="px-3 py-3 font-medium">Date</th><th scope="col" className="px-3 py-3 font-medium">Description</th><th scope="col" className="px-3 py-3 font-medium">Direction</th><th scope="col" className="px-3 py-3 font-medium">Recorded by</th><th scope="col" className="px-3 py-3 text-right font-medium">Amount</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {transactions.map((transaction) => (
                    <tr key={transaction.id} data-ledger-entry={transaction.id}>
                      <td className="px-3 py-4 align-top text-xs text-muted-foreground"><time dateTime={transaction.transactionDate}>{formatTransactionDateOnly(transaction.transactionDate)}</time></td>
                      <td className="max-w-64 px-3 py-4 align-top wrap-anywhere">{transaction.note || "No note provided"}</td>
                      <td className="px-3 py-4 align-top"><Direction type={transaction.type} /></td>
                      <td className="max-w-40 px-3 py-4 align-top text-xs text-muted-foreground wrap-anywhere">{transaction.createdByName}</td>
                      <td className={`px-3 py-4 text-right align-top font-semibold whitespace-nowrap tabular-nums ${transaction.type === "ADD" ? "text-positive" : "text-destructive"}`}>{formatSignedCurrency(transaction.amountInCents, transaction.type)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border lg:hidden" aria-label="Team transactions">
              {transactions.map((transaction) => (
                <li key={transaction.id} data-ledger-entry={transaction.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <Direction type={transaction.type} />
                    <span className={`max-w-full text-right font-semibold wrap-anywhere tabular-nums ${transaction.type === "ADD" ? "text-positive" : "text-destructive"}`}>{formatSignedCurrency(transaction.amountInCents, transaction.type)}</span>
                  </div>
                  <p className="text-sm leading-6 wrap-anywhere">{transaction.note || "No note provided"}</p>
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs leading-5 text-muted-foreground">
                    <time dateTime={transaction.transactionDate}>{formatTransactionDateOnly(transaction.transactionDate)}</time>
                    <span className="wrap-anywhere">Recorded by {transaction.createdByName}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 space-y-3" aria-busy={isPending}>
              {errorMessage ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm leading-6 text-destructive">{errorMessage}</p> : null}
              {nextCursor ? (
                <Button ref={paginationButtonRef} type="button" variant="outline" className="w-full aria-disabled:cursor-wait aria-disabled:opacity-60" aria-disabled={isPending} onClick={loadNextPage}>
                  {isPending ? <><LoaderCircle className="animate-spin" aria-hidden="true" />Loading history...</> : "Load more transactions"}
                </Button>
              ) : <p ref={completionRef} tabIndex={-1} role="status" className="rounded-md text-center text-xs leading-5 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">All available transactions are loaded.</p>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
