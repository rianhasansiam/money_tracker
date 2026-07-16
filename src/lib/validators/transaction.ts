import type { ZodError } from "zod";
import { z } from "zod";
import {
  getBusinessTodayDateInputValue,
  isFutureTransactionDate,
  isValidCalendarDateInput,
} from "@/lib/date-time";
import {
  MAX_MONEY_INPUT_LENGTH,
  getMoneyInputErrorReason,
} from "@/lib/money";

const transactionTypeValues = ["ADD", "REMOVE"] as const;
export type TransactionTypeValue = (typeof transactionTypeValues)[number];

const amountSchema = z
  .string()
  .max(
    MAX_MONEY_INPUT_LENGTH,
    `Amount must be ${MAX_MONEY_INPUT_LENGTH} characters or fewer.`,
  )
  .trim()
  .min(1, "Amount is required.")
  .superRefine((value, context) => {
    if (!value) {
      return;
    }

    const reason = getMoneyInputErrorReason(value);

    if (reason === "non-positive") {
      context.addIssue({
        code: "custom",
        message: "Amount must be greater than zero.",
      });
    } else if (reason === "too-large") {
      context.addIssue({
        code: "custom",
        message: "Amount cannot exceed 21,474,836.47 BDT.",
      });
    } else if (reason === "format") {
      context.addIssue({
        code: "custom",
        message:
          "Use digits with optional 3-digit comma groups and up to two decimal places.",
      });
    }
  });

const transactionDateSchema = z
  .string()
  .trim()
  .min(1, "Created date is required.")
  .superRefine((value, context) => {
    if (!value) {
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      context.addIssue({
        code: "custom",
        message: "Use a date in YYYY-MM-DD format.",
      });
      return;
    }

    if (!isValidCalendarDateInput(value)) {
      context.addIssue({
        code: "custom",
        message: "Use a real calendar date.",
      });
      return;
    }

    if (isFutureTransactionDate(value)) {
      context.addIssue({
        code: "custom",
        message: "Created date cannot be in the future.",
      });
    }
  });

export const transactionFormSchema = z
  .object({
    amount: amountSchema,
    note: z
      .string()
      .trim()
      .max(240, "Keep notes to 240 characters or fewer."),
    type: z.enum(transactionTypeValues, {
      error: "Choose whether this adds money or removes money.",
    }),
    transactionDate: transactionDateSchema,
  })
  .strict();

export type TransactionFormValues = z.infer<typeof transactionFormSchema>;

export function getTransactionFormDefaults(
  instant = new Date(),
): TransactionFormValues {
  return {
    amount: "",
    note: "",
    type: "ADD",
    transactionDate: getBusinessTodayDateInputValue(instant),
  };
}

export function flattenTransactionErrors(error: ZodError<TransactionFormValues>) {
  const flattened = error.flatten().fieldErrors;

  return Object.fromEntries(
    Object.entries(flattened).map(([key, value]) => [key, value?.[0]]),
  ) as Partial<Record<keyof TransactionFormValues, string>>;
}
