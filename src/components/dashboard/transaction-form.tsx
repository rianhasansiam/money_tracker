"use client";

import { type FormEvent, type Ref, useEffect, useImperativeHandle, useRef, useState, useTransition } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDownLeft, ArrowUpRight, CalendarDays, Coins, LoaderCircle } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { createTransaction, type TransactionActionResult } from "@/actions/transactions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTransactionDraftMemory, type TransactionDraftPhase } from "@/components/dashboard/transaction-draft-memory";
import { getBusinessTodayDateInputValue } from "@/lib/date-time";
import { applyServerFieldErrors } from "@/lib/server-field-errors";
import { getOrCreateTransactionOperation, type PendingTransactionOperation } from "@/lib/transaction-operation";
import { cn } from "@/lib/utils";
import { getTransactionFormDefaults, type TransactionFormValues, type TransactionTypeValue, transactionFormSchema } from "@/lib/validators/transaction";

export type TransactionEntryPhase = TransactionDraftPhase;
export interface TransactionEntryState { phase: TransactionEntryPhase; dirty: boolean; direction: TransactionTypeValue }
export interface TransactionFormHandle { prepare: (type: TransactionTypeValue) => void; discard: () => void; focus: () => void }

interface TransactionFormProps {
  ref?: Ref<TransactionFormHandle>;
  teamId: string;
  teamName: string;
  scope: string;
  onStateChange: (state: TransactionEntryState) => void;
  onSaved: (result: Extract<TransactionActionResult, { status: "success" }>) => void;
}

/** Kept mounted inside the dialog: closing it never destroys a draft or retry key. */
export function TransactionForm({ ref, teamId, teamName, scope, onStateChange, onSaved }: TransactionFormProps) {
  const memory = useTransactionDraftMemory();
  const [owner] = useState(() => ({}));
  const [restored] = useState(() => memory.get(scope));
  const [phase, setPhase] = useState<TransactionEntryPhase>(restored?.phase === "pending" ? "outcome-unknown" : restored?.phase ?? "editing");
  const [message, setMessage] = useState<string | null>(restored?.phase === "pending" ? "A previous submission was not confirmed. Retry its unchanged operation to check whether it was saved." : restored?.message ?? null);
  const [discardRequested, setDiscardRequested] = useState(false);
  const [isTransitionPending, startTransition] = useTransition();
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const operationRef = useRef<PendingTransactionOperation | null>(restored?.operation ?? null);
  const uncertainValuesRef = useRef<TransactionFormValues | null>(restored?.phase === "pending" ? restored.values : restored?.uncertainValues ?? null);
  const form = useForm<TransactionFormValues>({ resolver: zodResolver(transactionFormSchema), defaultValues: restored?.values ?? getTransactionFormDefaults() });
  const values = useWatch({ control: form.control });
  const direction = values.type ?? "ADD";
  const dirty = Boolean(values.amount?.trim() || values.note?.trim() || values.transactionDate !== getBusinessTodayDateInputValue());
  const busy = phase === "pending" || isTransitionPending;
  const uncertain = phase === "outcome-unknown";

  useEffect(() => {
    mountedRef.current = true;
    memory.save(scope, { values: form.getValues(), operation: restored?.operation ?? null, uncertainValues: restored?.phase === "pending" ? restored.values : restored?.uncertainValues ?? null, phase: restored?.phase === "pending" ? "outcome-unknown" : restored?.phase ?? "editing", message: restored?.message ?? null, owner });
    return () => {
      mountedRef.current = false;
      const snapshot = memory.get(scope);
      if (snapshot?.owner !== owner) return;
      if (snapshot.phase === "pending") memory.save(scope, { ...snapshot, phase: "outcome-unknown", uncertainValues: snapshot.values, message: "A previous submission was not confirmed. Retry its unchanged operation before recording it again." });
      else if (!snapshot.operation && !snapshot.values.amount.trim() && !snapshot.values.note.trim() && snapshot.values.transactionDate === getBusinessTodayDateInputValue()) memory.remove(scope, owner);
    };
  }, [memory, scope, form, owner, restored]);
  useEffect(() => { onStateChange({ phase, dirty, direction }); }, [phase, dirty, direction, onStateChange]);
  useEffect(() => {
    if (memory.get(scope)?.owner !== owner) return;
    memory.save(scope, { values: form.getValues(), operation: operationRef.current, uncertainValues: uncertainValuesRef.current, phase, message, owner });
  }, [values.amount, values.note, values.transactionDate, values.type, phase, message, memory, scope, owner, form]);

  function discard() {
    if (submittingRef.current || uncertain) return;
    operationRef.current = null;
    uncertainValuesRef.current = null;
    form.reset(getTransactionFormDefaults());
    setMessage(null);
    setDiscardRequested(false);
    setPhase("editing");
    form.setFocus("amount");
  }

  useImperativeHandle(ref, () => ({
    prepare(type) {
      if (submittingRef.current || uncertain) return;
      // Resume existing input instead of changing an entered amount's meaning.
      if (!dirty) {
        form.setValue("type", type, { shouldDirty: false });
        form.clearErrors();
        setMessage(null);
      }
      setPhase("editing");
      setDiscardRequested(false);
    },
    discard,
    focus() { if (uncertain) alertRef.current?.focus(); else form.setFocus("amount"); },
  }));

  function focusError(fieldErrors?: Partial<Record<keyof TransactionFormValues, string>>) {
    const field = fieldErrors && (Object.keys(fieldErrors)[0] as keyof TransactionFormValues | undefined);
    requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      if (field) form.setFocus(field);
      else alertRef.current?.focus();
    });
  }

  async function submitTransaction(input: TransactionFormValues, retryUnknown = false) {
    if (submittingRef.current) return;
    const payload = retryUnknown ? uncertainValuesRef.current : input;
    if (!payload) return;
    const operation = retryUnknown ? operationRef.current : getOrCreateTransactionOperation(operationRef.current, payload, () => crypto.randomUUID());
    if (!operation) return;
    operationRef.current = operation;
    submittingRef.current = true;
    setPhase("pending");
    setMessage(null);
    form.clearErrors();
    memory.save(scope, { values: { ...payload }, operation, uncertainValues: retryUnknown ? { ...payload } : null, phase: "pending", message: null, owner });
    try {
      let result: TransactionActionResult;
      try {
        result = await createTransaction(teamId, operation.key, payload);
      } catch {
        if (!mountedRef.current) {
          const snapshot = memory.get(scope);
          if (snapshot?.owner === owner) memory.save(scope, { ...snapshot, phase: "outcome-unknown", uncertainValues: { ...payload }, message: "We could not confirm the response. Retry the unchanged operation to check it safely." });
          return;
        }
        uncertainValuesRef.current = { ...payload };
        setPhase("outcome-unknown");
        setMessage("We could not confirm the response. This entry may already be saved. Retry the unchanged operation to check it safely; its original operation key is retained while this page stays open.");
        focusError();
        return;
      }
      if (!mountedRef.current) {
        const snapshot = memory.get(scope);
        if (snapshot?.owner === owner) {
          if (result.status === "success") memory.remove(scope, owner);
          else memory.save(scope, { ...snapshot, phase: retryUnknown || result.code === "OUTCOME_UNKNOWN" ? "outcome-unknown" : "recoverable-failure", uncertainValues: retryUnknown || result.code === "OUTCOME_UNKNOWN" ? { ...payload } : null, message: result.message });
        }
        return;
      }
      if (result.status === "error") {
        if (result.code === "OUTCOME_UNKNOWN" || retryUnknown) {
          uncertainValuesRef.current = { ...payload };
          setPhase("outcome-unknown");
        } else {
          uncertainValuesRef.current = null;
          setPhase("recoverable-failure");
        }
        if (result.code === "IDEMPOTENCY_CONFLICT" && !retryUnknown) operationRef.current = null;
        if (result.fieldErrors) applyServerFieldErrors<TransactionFormValues>(form.setError, result.fieldErrors);
        setMessage(result.message);
        focusError(result.code === "OUTCOME_UNKNOWN" || retryUnknown ? undefined : result.fieldErrors);
        return;
      }
      operationRef.current = null;
      uncertainValuesRef.current = null;
      form.reset({ ...getTransactionFormDefaults(), type: payload.type });
      setPhase("confirmed");
      setMessage(result.message);
      onSaved(result);
    } finally {
      submittingRef.current = false;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    void form.handleSubmit(
      (input) => startTransition(async () => { await submitTransaction(input); }),
      () => { setPhase("recoverable-failure"); setMessage("Correct the highlighted fields, then save again."); },
    )(event);
  }

  return (
    <form id="transaction-form" onSubmit={handleSubmit} aria-busy={busy} data-entry-phase={phase} className="mt-5 space-y-5">
      <div className="rounded-lg bg-muted px-3 py-3 text-sm leading-6"><p className="font-medium wrap-anywhere">Target team: {teamName}</p><p className="text-muted-foreground">Entries are permanent. Review the direction and amount before saving.</p></div>
      <fieldset disabled={busy || uncertain} className="min-w-0 space-y-5">
        <legend className="sr-only">Transaction details</legend>
        <div className="space-y-2">
          <Label htmlFor="type">Transaction type</Label>
          <select id="type" className="h-11 w-full rounded-lg border border-border bg-input px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" {...form.register("type")} aria-describedby="type-help"><option value="ADD">Add money</option><option value="REMOVE">Remove money</option></select>
          <p id="type-help" className={cn("flex items-center gap-1.5 text-sm", direction === "ADD" ? "text-positive" : "text-foreground")}>{direction === "ADD" ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : <ArrowDownLeft className="h-4 w-4" aria-hidden="true" />}{direction === "ADD" ? "Money coming into the team" : "Money leaving the team"}</p>
        </div>
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label htmlFor="amount">Amount in BDT</Label>
            <div className="relative"><Coins className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input id="amount" placeholder="e.g. 1,250.50" inputMode="decimal" autoComplete="off" className="pl-10 tabular-nums" aria-invalid={Boolean(form.formState.errors.amount)} aria-describedby="amount-help" {...form.register("amount")} /></div>
            <p id="amount-help" className={cn("text-xs leading-5", form.formState.errors.amount ? "text-destructive" : "text-muted-foreground")}>{form.formState.errors.amount?.message ?? "BDT 0.01–21,474,836.47, up to two decimal places."}</p>
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="transactionDate">Transaction date</Label>
            <div className="relative"><CalendarDays className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input id="transactionDate" type="date" min="0001-01-01" max={getBusinessTodayDateInputValue()} className="min-w-0 pl-10" aria-invalid={Boolean(form.formState.errors.transactionDate)} aria-describedby="date-help" {...form.register("transactionDate")} /></div>
            <p id="date-help" className={cn("text-xs leading-5", form.formState.errors.transactionDate ? "text-destructive" : "text-muted-foreground")}>{form.formState.errors.transactionDate?.message ?? "Today or an earlier date, in Asia/Dhaka."}</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="note">Note <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea id="note" placeholder="What was this transaction for?" rows={3} aria-invalid={Boolean(form.formState.errors.note)} aria-describedby="note-help note-count" {...form.register("note")} />
          <div className="flex flex-wrap justify-between gap-2 text-xs leading-5"><p id="note-help" className={form.formState.errors.note ? "text-destructive" : "text-muted-foreground"}>{form.formState.errors.note?.message ?? "Describe the entry for your team."}</p><p id="note-count" className="text-muted-foreground tabular-nums">{values.note?.trim().length ?? 0}/240 characters</p></div>
        </div>
      </fieldset>
      {message ? <p ref={alertRef} tabIndex={-1} role={phase === "confirmed" ? "status" : "alert"} className={cn("rounded-lg border p-3 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-primary", phase === "confirmed" ? "border-primary/20 bg-primary/5" : "border-warning/30 bg-warning/5")}>{message}</p> : null}
      {uncertain ? <Button type="button" size="lg" className="w-full" disabled={busy} onClick={() => startTransition(async () => { await submitTransaction(form.getValues(), true); })}>Retry unchanged {direction === "ADD" ? "addition" : "removal"}</Button> : <Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? <><LoaderCircle className="animate-spin" aria-hidden="true" />Saving transaction...</> : direction === "ADD" ? "Save addition" : "Save removal"}</Button>}
      <p role="status" className="text-xs leading-5 text-muted-foreground">{busy ? "Saving your entry. Please wait for confirmation." : uncertain ? "Closing this panel or switching teams keeps this operation in memory for this team. Signing out or reloading loses its retry information." : "The balance and history update after the server confirms your entry."}</p>
      {dirty && !busy && !uncertain ? <div className="border-t border-border pt-3">{discardRequested ? <div className="space-y-3 text-sm"><p>Discard this unsaved input? No entry will be submitted.</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => setDiscardRequested(false)}>Keep draft</Button><Button type="button" variant="outline" onClick={discard}>Discard draft</Button></div></div> : <Button type="button" variant="ghost" onClick={() => setDiscardRequested(true)}>Discard draft</Button>}</div> : null}
    </form>
  );
}
