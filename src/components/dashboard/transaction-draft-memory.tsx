"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  useSyncExternalStore, type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { getBusinessTodayDateInputValue } from "@/lib/date-time";
import type { PendingTransactionOperation } from "@/lib/transaction-operation";
import type { TransactionFormValues } from "@/lib/validators/transaction";

export type TransactionDraftPhase = "editing" | "pending" | "confirmed" | "recoverable-failure" | "outcome-unknown";

export interface TransactionDraftSnapshot {
  values: TransactionFormValues;
  operation: PendingTransactionOperation | null;
  uncertainValues: TransactionFormValues | null;
  phase: TransactionDraftPhase;
  message: string | null;
  owner: object;
}

interface TransactionDraftMemory {
  get(scope: string): TransactionDraftSnapshot | undefined;
  save(scope: string, snapshot: TransactionDraftSnapshot): void;
  remove(scope: string, owner?: object): void;
}

interface DraftStatus { drafts: number; pending: number; unknown: number }
const EMPTY_STATUS: DraftStatus = { drafts: 0, pending: 0, unknown: 0 };

function copy(snapshot: TransactionDraftSnapshot): TransactionDraftSnapshot {
  return {
    ...snapshot,
    values: { ...snapshot.values },
    operation: snapshot.operation ? { ...snapshot.operation } : null,
    uncertainValues: snapshot.uncertainValues ? { ...snapshot.uncertainValues } : null,
  };
}

function unresolved(snapshot: TransactionDraftSnapshot) {
  return snapshot.phase !== "confirmed" && (
    snapshot.phase === "pending" || snapshot.phase === "outcome-unknown" ||
    Boolean(snapshot.values.amount.trim() || snapshot.values.note.trim() ||
      snapshot.values.transactionDate !== getBusinessTodayDateInputValue())
  );
}

/** No serialization, browser storage, history state or network persistence. */
export function createTransactionDraftMemoryStore() {
  const entries = new Map<string, TransactionDraftSnapshot>();
  const listeners = new Set<() => void>();
  let status = EMPTY_STATUS;
  function updateStatus() {
    const current = Array.from(entries.values()).filter(unresolved);
    const next = {
      drafts: current.length,
      pending: current.filter((snapshot) => snapshot.phase === "pending").length,
      unknown: current.filter((snapshot) => snapshot.phase === "outcome-unknown").length,
    };
    if (next.drafts !== status.drafts || next.pending !== status.pending || next.unknown !== status.unknown) {
      status = next;
      listeners.forEach((listener) => listener());
    }
  }
  const api: TransactionDraftMemory = {
    get(scope) {
      const snapshot = entries.get(scope);
      return snapshot ? copy(snapshot) : undefined;
    },
    save(scope, snapshot) {
      entries.set(scope, copy(snapshot));
      updateStatus();
    },
    remove(scope, owner) {
      if (owner !== undefined && entries.get(scope)?.owner !== owner) return;
      entries.delete(scope);
      updateStatus();
    },
  };
  return {
    api,
    clear() {
      entries.clear();
      updateStatus();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getStatus: () => status,
  };
}

const MemoryContext = createContext<TransactionDraftMemory | null>(null);

export function useTransactionDraftMemory() {
  const memory = useContext(MemoryContext);
  if (!memory) throw new Error("Transaction draft memory requires the workspace provider.");
  return memory;
}

interface SessionFormNavigation {
  form: HTMLFormElement;
  submitter: HTMLButtonElement | HTMLInputElement | null;
  kind: "signout" | "reauth";
}

export function TransactionDraftMemoryProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [memoryStore] = useState(() => createTransactionDraftMemoryStore());
  const api = useMemo(() => memoryStore.api, [memoryStore]);
  const status = useSyncExternalStore(memoryStore.subscribe, memoryStore.getStatus, () => EMPTY_STATUS);
  const [navigationState, setNavigationState] = useState<{ pathname: string | null; target: SessionFormNavigation | null }>({ pathname, target: null });
  if (navigationState.pathname !== pathname) {
    setNavigationState({ pathname, target: null });
  }
  const navigation = navigationState.pathname === pathname ? navigationState.target : null;
  const setNavigation = useCallback((target: SessionFormNavigation | null) => {
    setNavigationState({ pathname, target });
  }, [pathname]);
  const confirmedForms = useRef(new WeakSet<HTMLFormElement>());
  const leaving = useRef(false);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (memoryStore.getStatus().drafts === 0) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function submit(event: SubmitEvent) {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const kind = form.dataset.sessionNavigation;
      if (kind !== "signout" && kind !== "reauth") return;
      if (confirmedForms.current.delete(form) || memoryStore.getStatus().drafts === 0) {
        memoryStore.clear();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      leaving.current = false;
      const submitter = event.submitter;
      setNavigation({
        form, kind,
        submitter: submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null,
      });
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("submit", submit, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("submit", submit, true);
    };
  }, [memoryStore, setNavigation]);

  function leaveSession() {
    if (!navigation || leaving.current || memoryStore.getStatus().pending > 0) return;
    setNavigation(null);
    const { form, submitter } = navigation;
    if (!form.isConnected) return;
    leaving.current = true;
    // The user explicitly chose discard, even if the subsequent sign-out or
    // reauthentication request fails. SPA route changes alone never clear it.
    memoryStore.clear();
    // This one-shot acknowledgement applies only to the marked session form.
    // Financial operations are never captured, submitted or replayed here.
    confirmedForms.current.add(form);
    try {
      form.requestSubmit(submitter?.form === form && !submitter.disabled ? submitter : undefined);
    } finally {
      confirmedForms.current.delete(form);
    }
  }

  return <MemoryContext.Provider value={api}>
    {children}
    <ConfirmationDialog open={navigation !== null} busy={false}
      title={navigation?.kind === "reauth" ? "Sign in again and discard these drafts?" : "Sign out and discard these drafts?"}
      description={status.unknown > 0
        ? "An operation has an unknown outcome and may already be saved. Discarding clears its original retry information before sign-out or reauthentication, even if that request fails. Stay to resolve it safely, or review the team ledger before recording it again. This confirmation never submits a transaction."
        : "Drafts remain in this browser page's memory as you navigate. Confirming discards unsaved input before sign-out or reauthentication, even if that request fails. No transaction will be submitted by this confirmation."}
      closeLabel="Keep editing transaction drafts" onClose={() => setNavigation(null)}>
      <div className="mt-5 space-y-4">
        {status.pending > 0 ? <p role="status" className="text-sm leading-6">A financial request is still pending. Wait for its result before leaving this session.</p> : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => setNavigation(null)}>Keep editing</Button>
          <Button type="button" disabled={status.pending > 0} onClick={leaveSession}>Discard drafts and leave session</Button>
        </div>
      </div>
    </ConfirmationDialog>
  </MemoryContext.Provider>;
}
