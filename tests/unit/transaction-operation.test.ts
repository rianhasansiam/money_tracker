import { describe, expect, it, vi } from "vitest";
import { getOrCreateTransactionOperation } from "@/lib/transaction-operation";
import type { TransactionFormValues } from "@/lib/validators/transaction";

const values: TransactionFormValues = {
  amount: "1,000.50",
  note: "Office supplies",
  transactionDate: "2026-07-15",
  type: "ADD",
};

describe("getOrCreateTransactionOperation", () => {
  it("reuses one operation key for retries of the same logical payload", () => {
    const createKey = vi.fn(() => "operation-1");
    const first = getOrCreateTransactionOperation(null, values, createKey);
    const retry = getOrCreateTransactionOperation(first, { ...values }, createKey);

    expect(retry).toBe(first);
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it.each(["amount", "note", "transactionDate", "type"] as const)(
    "creates a new key when %s changes",
    (field) => {
      const createKey = vi
        .fn<() => string>()
        .mockReturnValueOnce("operation-1")
        .mockReturnValueOnce("operation-2");
      const first = getOrCreateTransactionOperation(null, values, createKey);
      const changedValues: TransactionFormValues = {
        ...values,
        [field]:
          field === "type"
            ? "REMOVE"
            : field === "transactionDate"
              ? "2026-07-14"
              : field === "amount"
                ? "20.00"
                : "Changed note",
      };

      const next = getOrCreateTransactionOperation(
        first,
        changedValues,
        createKey,
      );

      expect(next.key).toBe("operation-2");
      expect(createKey).toHaveBeenCalledTimes(2);
    },
  );
});
