"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Lock, RefreshCw } from "lucide-react";
import { loadFilteredDashboard } from "@/actions/dashboard";
import type { TransactionActionResult } from "@/actions/transactions";
import { BalanceCard } from "@/components/dashboard/balance-card";
import { HistoryControls } from "@/components/dashboard/history-controls";
import { TransactionForm, type TransactionEntryState, type TransactionFormHandle } from "@/components/dashboard/transaction-form";
import { TransactionList } from "@/components/dashboard/transaction-list";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { hasHistoryFilters, historyFilterNavigationSearch, historyFiltersFromSearchParams, type HistoryFilterFieldErrors, type HistoryFilterInput } from "@/lib/history-filters";
import { formatCurrencyFromMinorUnits } from "@/lib/money";
import type { DashboardDataDto } from "@/lib/queries/dashboard";
import { formatRoleLabel } from "@/lib/roles";
import type { TransactionTypeValue } from "@/lib/validators/transaction";

type SavedTransaction = Extract<TransactionActionResult, { status: "success" }>;
const refreshedTime = new Intl.DateTimeFormat("en-BD", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });

/** Each read replaces one coherent server snapshot. Search and drafts stay in memory. */
export function DashboardShell({ initialData }: { initialData: DashboardDataDto }) {
  const [data, setData] = useState(initialData);
  const [draftFilters, setDraftFilters] = useState<HistoryFilterInput>(initialData.historyFilters);
  const [filterErrors, setFilterErrors] = useState<HistoryFilterFieldErrors>({});
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entry, setEntry] = useState<TransactionEntryState>({ phase: "editing", dirty: false, direction: "ADD" });
  const formRef = useRef<TransactionFormHandle>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const dataRef = useRef(data);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const isSaving = entry.phase === "pending";
  const hasDraft = entry.dirty || entry.phase === "outcome-unknown" || isSaving;
  const updateEntry = useCallback((state: TransactionEntryState) => setEntry(state), []);
  const focusEntry = useCallback(() => formRef.current?.focus(), []);

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestRef.current += 1; };
  }, []);

  const requestSnapshot = useCallback(async (input: HistoryFilterInput, navigate = false, saved?: SavedTransaction) => {
    const request = ++requestRef.current;
    setRefreshing(true);
    setReadError(null);
    setFilterErrors({});
    try {
      const result = await loadFilteredDashboard(initialData.teamId, input);
      if (!mountedRef.current || requestRef.current !== request) return false;
      if (result.status === "error") {
        setReadError(saved ? `Your entry is saved. ${result.message} Refresh the dashboard to update the displayed balance and history.` : result.message);
        setFilterErrors(result.fieldErrors ?? {});
        requestAnimationFrame(() => {
          const key = Object.keys(result.fieldErrors ?? {})[0];
          if (key) document.getElementById(`history-${key}`)?.focus();
          else alertRef.current?.focus();
        });
        return false;
      }
      const previous = dataRef.current;
      setData(result.data);
      dataRef.current = result.data;
      setDraftFilters(result.data.historyFilters);
      if (navigate) {
        const query = historyFilterNavigationSearch(result.data.historyFilters);
        const href = `/dashboard/${result.data.teamId}${query ? `?${query}` : ""}`;
        if (`${window.location.pathname}${window.location.search}` !== href) window.history.pushState(null, "", href);
      }
      if (saved) {
        const visible = result.data.transactionHistory.transactions.some((transaction) => transaction.id === saved.transactionId);
        setNotice(saved.replayed && previous.snapshotRevision === result.data.snapshotRevision
          ? "This entry was already saved. No duplicate was created; the current ledger has not changed."
          : visible
            ? "Entry saved. History has reset to the newest matching first page; load older entries again below."
            : "Entry saved. It is outside the current filters or first page. The balance includes it; clear filters or load older entries to find it. History has reset to the newest matching first page.");
      } else if (previous.snapshotRevision !== result.data.snapshotRevision) {
        setNotice("The history view was updated. History has reset to the newest matching first page; load older entries again below.");
      }
      return true;
    } catch {
      if (mountedRef.current && requestRef.current === request) {
        setReadError(saved ? "Your entry is saved. We could not refresh this view; use Refresh dashboard to retrieve the current balance and history." : "We could not refresh this view. Your previous results are still shown. Try again.");
      }
      return false;
    } finally {
      if (mountedRef.current && requestRef.current === request) setRefreshing(false);
    }
  }, [initialData.teamId]);

  useEffect(() => {
    function popState() {
      if (window.location.pathname !== `/dashboard/${initialData.teamId}`) return;
      try {
        const params = Object.fromEntries(new URLSearchParams(window.location.search));
        const navigationFilters = historyFiltersFromSearchParams(params);
        void requestSnapshot({ ...navigationFilters, search: dataRef.current.historyFilters.search });
      } catch {
        setReadError("This history link contains invalid filters. Clear filters to choose a valid view.");
      }
    }
    window.addEventListener("popstate", popState);
    return () => window.removeEventListener("popstate", popState);
  }, [initialData.teamId, requestSnapshot]);


  function openEntry(type: TransactionTypeValue) {
    formRef.current?.prepare(type);
    setEntryOpen(true);
  }
  function saved(result: SavedTransaction) {
    setEntryOpen(false);
    setNotice("Your entry is saved. Retrieving the current balance and matching history…");
    void requestSnapshot(dataRef.current.historyFilters, false, result);
  }
  const filtersActive = hasHistoryFilters(data.historyFilters);

  return (
    <section className="min-w-0 space-y-5" aria-label="Team ledger">
      <BalanceCard teamName={data.teamName} canManageTransactions={data.canManageTransactions} isSaving={isSaving} balanceInCents={data.balanceInCents} totalAddedInCents={data.totalAddedInCents} totalRemovedInCents={data.totalRemovedInCents} onQuickAction={openEntry} />
      {!data.canManageTransactions ? <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-sm leading-6"><Lock className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><p><strong>View-only access.</strong> Your team role is {formatRoleLabel(data.viewerRole)}. You can review this ledger; a team Admin or Moderator can record money.</p></div> : null}
      {hasDraft && !entryOpen ? <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm leading-6"><p>{entry.phase === "outcome-unknown" ? "An entry has an unconfirmed outcome. Its original retry information is retained for this team until you sign out or reload." : "Your transaction draft is retained for this team until you sign out or reload."}</p><Button type="button" variant="outline" onClick={() => openEntry(entry.direction)}>Resume {entry.phase === "outcome-unknown" ? "unchanged operation" : "draft"}</Button></div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs leading-5 text-muted-foreground">Last refreshed <time dateTime={data.refreshedAt}>{refreshedTime.format(new Date(data.refreshedAt))}</time> · Asia/Dhaka</p><Button type="button" variant="outline" disabled={refreshing || isSaving} onClick={() => { void requestSnapshot(data.historyFilters); }}><RefreshCw className={refreshing ? "animate-spin" : ""} aria-hidden="true" />{refreshing ? "Refreshing…" : "Refresh dashboard"}</Button></div>
      {notice ? <div role="status" className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm leading-6"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><p>{notice}</p></div> : null}
      <HistoryControls applied={data.historyFilters} draft={draftFilters} onDraftChange={setDraftFilters} onApply={(filters) => requestSnapshot(filters, true)} pending={refreshing} errors={filterErrors} />
      {readError ? <p ref={alertRef} role="alert" tabIndex={-1} className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-primary">{readError}</p> : null}
      {filtersActive ? <section aria-label="Matching transactions" className="rounded-lg border border-border bg-muted/40 px-4 py-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Matching transactions</h2><p className="text-xs text-muted-foreground">{data.matchingSummary.matchingCount} matching · across the full ledger</p></div><dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">Money added</dt><dd data-testid="matching-added" className="mt-1 font-medium wrap-anywhere tabular-nums">{formatCurrencyFromMinorUnits(data.matchingSummary.totalAddedInCents)}</dd></div><div><dt className="text-xs text-muted-foreground">Money removed</dt><dd data-testid="matching-removed" className="mt-1 font-medium wrap-anywhere tabular-nums">{formatCurrencyFromMinorUnits(data.matchingSummary.totalRemovedInCents)}</dd></div><div><dt className="text-xs text-muted-foreground">Net change · matching only</dt><dd data-testid="matching-net" className="mt-1 font-semibold wrap-anywhere tabular-nums">{formatCurrencyFromMinorUnits(data.matchingSummary.netChangeInCents)}</dd></div></dl></section> : null}
      <div aria-busy={refreshing} className={refreshing ? "opacity-70" : undefined}><TransactionList key={data.snapshotRevision} snapshotRevision={data.snapshotRevision} teamId={data.teamId} initialPage={data.transactionHistory} filters={data.historyFilters} ledgerHasTransactions={data.ledgerHasTransactions} onSnapshotChanged={() => { void requestSnapshot(data.historyFilters); }} /></div>
      <p className="text-xs leading-5 text-muted-foreground">Entries are permanent and include who recorded them. All-time balance is independent of history filters.</p>
      {data.canManageTransactions ? <ConfirmationDialog open={entryOpen} busy={isSaving} title={entry.direction === "ADD" ? "Add money" : "Remove money"} description="Record one entry for this team. Closing the panel or switching teams retains this draft until you sign out or reload." closeLabel="Close transaction entry" contentClassName="max-w-2xl max-sm:min-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)]" onOpenFocus={focusEntry} onClose={() => setEntryOpen(false)}><TransactionForm ref={formRef} scope={data.snapshotScope} teamId={data.teamId} teamName={data.teamName} onStateChange={updateEntry} onSaved={saved} /></ConfirmationDialog> : null}

    </section>
  );
}
