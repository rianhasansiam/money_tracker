import type { TransactionFormValues } from "@/lib/validators/transaction";

export interface PendingTransactionOperation {
  key: string;
  payloadSignature: string;
}

function createPayloadSignature(values: TransactionFormValues) {
  return JSON.stringify({
    amount: values.amount,
    note: values.note,
    transactionDate: values.transactionDate,
    type: values.type,
  });
}

export function getOrCreateTransactionOperation(
  current: PendingTransactionOperation | null,
  values: TransactionFormValues,
  createKey: () => string,
): PendingTransactionOperation {
  const payloadSignature = createPayloadSignature(values);

  if (current?.payloadSignature === payloadSignature) {
    return current;
  }

  return {
    key: createKey(),
    payloadSignature,
  };
}
