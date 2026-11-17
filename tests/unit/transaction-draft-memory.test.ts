import { describe, expect, it, vi } from "vitest";
import { createTransactionDraftMemoryStore, type TransactionDraftSnapshot } from "@/components/dashboard/transaction-draft-memory";
import { getTransactionFormDefaults } from "@/lib/validators/transaction";

function snapshot(overrides: Partial<TransactionDraftSnapshot> = {}): TransactionDraftSnapshot {
  return {
    values: { ...getTransactionFormDefaults(), amount: "12.50", note: "Retained team entry" },
    operation: { key: "unchanged-operation-key", payloadSignature: "original-values-signature" },
    uncertainValues: null,
    phase: "editing", message: null, owner: {}, ...overrides,
  };
}

describe("workspace-only transaction draft memory", () => {
  it("retains independent actor/team scopes through SPA navigation without mutable reference sharing", () => {
    const store = createTransactionDraftMemoryStore();
    const first = snapshot();
    const second = snapshot({ values: { ...getTransactionFormDefaults(), amount: "2.00", type: "REMOVE" } });
    store.api.save("actor-one:team-A", first);
    store.api.save("actor-one:team-B", second);
    expect(store.api.get("actor-two:team-A")).toBeUndefined();
    const restored = store.api.get("actor-one:team-A")!;
    expect(restored.values).toEqual(first.values);
    expect(restored.operation).toEqual(first.operation);
    restored.values.amount = "999.99";
    restored.operation!.key = "changed-outside-store";
    expect(store.api.get("actor-one:team-A")?.values.amount).toBe("12.50");
    expect(store.api.get("actor-one:team-A")?.operation?.key).toBe("unchanged-operation-key");
    expect(store.api.get("actor-one:team-B")?.values.type).toBe("REMOVE");
  });

  it("preserves unknown payload/key and protects the new form owner from late old-instance cleanup", () => {
    const store = createTransactionDraftMemoryStore();
    const firstOwner = {};
    const nextOwner = {};
    const uncertain = snapshot({ owner: firstOwner, phase: "outcome-unknown" });
    uncertain.uncertainValues = { ...uncertain.values };
    store.api.save("scope", uncertain);
    store.api.save("scope", { ...store.api.get("scope")!, owner: nextOwner });
    store.api.remove("scope", firstOwner);
    expect(store.api.get("scope")).toMatchObject({ owner: nextOwner, operation: uncertain.operation, uncertainValues: uncertain.values, phase: "outcome-unknown" });
    store.api.remove("scope", nextOwner);
    expect(store.api.get("scope")).toBeUndefined();
  });

  it("notifies guard consumers only when unresolved/pending/unknown status changes", () => {
    const store = createTransactionDraftMemoryStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const current = snapshot();
    store.api.save("scope", current);
    expect(store.getStatus()).toEqual({ drafts: 1, pending: 0, unknown: 0 });
    const status = store.getStatus();
    store.api.save("scope", { ...current, values: { ...current.values, amount: "13.00" } });
    expect(store.getStatus()).toBe(status);
    expect(listener).toHaveBeenCalledTimes(1);
    store.api.save("scope", { ...current, phase: "pending" });
    expect(store.getStatus().pending).toBe(1);
    store.api.save("scope", { ...current, phase: "outcome-unknown", uncertainValues: current.values });
    expect(store.getStatus()).toEqual({ drafts: 1, pending: 0, unknown: 1 });
    store.api.remove("scope", current.owner);
    expect(store.getStatus().drafts).toBe(0);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("clears on an explicit session discard and accepts a fresh actor scope afterwards", () => {
    const store = createTransactionDraftMemoryStore();
    const current = snapshot({ phase: "outcome-unknown" });
    store.api.save("scope", current);
    store.clear();
    expect(store.api.get("scope")).toBeUndefined();
    expect(store.getStatus()).toEqual({ drafts: 0, pending: 0, unknown: 0 });
    store.api.remove("scope", current.owner);
    expect(store.api.get("scope")).toBeUndefined();
    store.api.save("scope", snapshot({ phase: "confirmed" }));
    expect(store.getStatus().drafts).toBe(0);
  });
});
