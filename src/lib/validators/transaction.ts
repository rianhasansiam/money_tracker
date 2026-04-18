import type { ZodError } from "zod";
import { z } from "zod";
import { getTodayDateInputValue, isFutureDateInput, isValidMoneyInput } from "@/lib/money";

export const transactionTypeValues = ["ADD", "REMOVE"] as const;
export type TransactionTypeValue = (typeof transactionTypeValues)[number];

export const transactionFormSchema = z.object({
  amount: z
    .string()
    .trim()
    .min(1, "Amount is required.")
    .refine(isValidMoneyInput, "Enter a valid amount greater than zero."),
  note: z
    .string()
    .trim()
    .max(240, "Keep notes to 240 characters or fewer."),
  type: z.enum(transactionTypeValues, {
    error: "Choose whether this adds money or removes money.",
  }),
  transactionDate: z
    .string()
    .min(1, "Created date is required.")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
    .refine((value) => !isFutureDateInput(value), "Created date cannot be in the future."),
});

export type TransactionFormValues = z.infer<typeof transactionFormSchema>;

export function getTransactionFormDefaults(): TransactionFormValues {
  return {
    amount: "",
    note: "",
    type: "ADD",
    transactionDate: getTodayDateInputValue(),
  };
}

export function flattenTransactionErrors(error: ZodError<TransactionFormValues>) {
  const flattened = error.flatten().fieldErrors;

  return Object.fromEntries(
    Object.entries(flattened).map(([key, value]) => [key, value?.[0]]),
  ) as Partial<Record<keyof TransactionFormValues, string>>;
}
