"use client";

import { type FormEvent, useState, useSyncExternalStore } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_HISTORY_FILTERS, MAX_HISTORY_SEARCH_LENGTH, hasHistoryFilters, type HistoryFilterFieldErrors, type HistoryFilterInput, type HistoryFilters } from "@/lib/history-filters";
import { getBusinessTodayDateInputValue } from "@/lib/date-time";

function subscribeMobile(listener: () => void) {
  const media = window.matchMedia("(max-width: 767px)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

interface HistoryControlsProps {
  applied: HistoryFilters;
  draft: HistoryFilterInput;
  onDraftChange: (draft: HistoryFilterInput) => void;
  onApply: (draft: HistoryFilterInput) => Promise<boolean>;
  pending: boolean;
  errors: HistoryFilterFieldErrors;
}

export function HistoryControls({ applied, draft, onDraftChange, onApply, pending, errors }: HistoryControlsProps) {
  const mobile = useSyncExternalStore(subscribeMobile, () => window.matchMedia("(max-width: 767px)").matches, () => false);
  const [open, setOpen] = useState(false);
  function field(key: keyof HistoryFilterInput, value: string) { onDraftChange({ ...draft, [key]: value }); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onApply(draft)) setOpen(false);
  }
  const form = (
    <form onSubmit={(event) => { void submit(event); }} aria-label="Transaction history filters" aria-busy={pending} className="space-y-3 xl:grid xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start xl:gap-x-4 xl:space-y-0">
      <fieldset disabled={pending} className="grid min-w-0 gap-4 md:grid-cols-[minmax(12rem,1fr)_minmax(10rem,0.55fr)_minmax(10rem,0.55fr)]">
        <legend className="sr-only">Search the full team ledger</legend>
        <div className="min-w-0 space-y-2"><Label htmlFor="history-search">Search notes</Label><div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input id="history-search" type="search" autoComplete="off" maxLength={MAX_HISTORY_SEARCH_LENGTH} value={draft.search ?? ""} onChange={(event) => field("search", event.target.value)} placeholder="e.g. studio supplies" className="pl-10" aria-invalid={Boolean(errors.search)} aria-describedby="history-search-help" /></div><p id="history-search-help" className={errors.search ? "text-xs text-destructive" : "text-xs leading-5 text-muted-foreground"}>{errors.search ?? "Literal note text across the full team history."}</p></div>
        <div className="space-y-2"><Label htmlFor="history-direction">Money direction</Label><select id="history-direction" className="h-11 w-full rounded-lg border border-border bg-input px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary" value={draft.direction ?? "ALL"} onChange={(event) => field("direction", event.target.value)} aria-invalid={Boolean(errors.direction)}><option value="ALL">All directions</option><option value="ADD">Money added</option><option value="REMOVE">Money removed</option></select>{errors.direction ? <p className="text-xs text-destructive">{errors.direction}</p> : null}</div>
        <div className="space-y-2"><Label htmlFor="history-period">Date range</Label><select id="history-period" className="h-11 w-full rounded-lg border border-border bg-input px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary" value={draft.period ?? "ALL"} onChange={(event) => field("period", event.target.value)} aria-invalid={Boolean(errors.period)}><option value="ALL">All time</option><option value="THIS_MONTH">This month</option><option value="LAST_MONTH">Last month</option><option value="CUSTOM">Custom date range</option></select>{errors.period ? <p className="text-xs text-destructive">{errors.period}</p> : null}</div>
        {draft.period === "CUSTOM" ? <div className="grid min-w-0 gap-4 sm:grid-cols-2 md:col-span-3"><div className="min-w-0 space-y-2"><Label htmlFor="history-from">From date</Label><Input id="history-from" type="date" min="0001-01-01" max={getBusinessTodayDateInputValue()} value={draft.from ?? ""} onChange={(event) => field("from", event.target.value)} aria-invalid={Boolean(errors.from)} aria-describedby="history-from-error" />{errors.from ? <p id="history-from-error" className="text-xs text-destructive">{errors.from}</p> : null}</div><div className="min-w-0 space-y-2"><Label htmlFor="history-to">To date</Label><Input id="history-to" type="date" min="0001-01-01" max={getBusinessTodayDateInputValue()} value={draft.to ?? ""} onChange={(event) => field("to", event.target.value)} aria-invalid={Boolean(errors.to)} aria-describedby="history-to-error" />{errors.to ? <p id="history-to-error" className="text-xs text-destructive">{errors.to}</p> : null}</div></div> : null}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 xl:pt-6"><Button type="submit" disabled={pending}>{pending ? "Applying filters…" : "Apply filters"}</Button><Button type="button" variant="ghost" disabled={pending} onClick={() => { void onApply(DEFAULT_HISTORY_FILTERS).then((success) => { if (success) setOpen(false); }); }}><X aria-hidden="true" />Clear filters</Button></div><p className="text-xs leading-5 text-muted-foreground xl:col-span-2">Dates use Asia/Dhaka. Search stays in this page’s memory and is not included in the URL.</p>
    </form>
  );
  return (
    <section aria-label="History discovery" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
      {mobile ? <><Button type="button" variant="outline" className="w-full" onClick={() => setOpen(true)}><SlidersHorizontal aria-hidden="true" />Search and filters{hasHistoryFilters(applied) ? " · Active" : ""}</Button><ConfirmationDialog open={open} busy={pending} title="Search and filter history" description="Find entries across the full authorized team ledger." closeLabel="Close transaction filters" contentClassName="max-w-3xl" onClose={() => setOpen(false)}><div className="mt-5">{form}</div></ConfirmationDialog></> : form}
      {hasHistoryFilters(applied) ? <div role="status" aria-label="Active transaction filters" className="flex flex-wrap gap-2 text-xs leading-5 text-muted-foreground"><span className="rounded-md bg-muted px-2 py-1">{applied.direction === "ALL" ? "All directions" : applied.direction === "ADD" ? "Money added" : "Money removed"}</span><span className="rounded-md bg-muted px-2 py-1">{applied.period === "ALL" ? "All time" : `${applied.from} to ${applied.to}`}</span>{applied.search ? <span className="max-w-full rounded-md bg-muted px-2 py-1 wrap-anywhere">Note contains: {applied.search}</span> : null}</div> : null}
    </section>
  );
}
