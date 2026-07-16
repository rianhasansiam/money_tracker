const moneyFormatter = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const MAX_TRANSACTION_AMOUNT_IN_CENTS = 2_147_483_647;
export const MAX_MONEY_INPUT_LENGTH = 32;

const MAX_TRANSACTION_AMOUNT_IN_MINOR_UNITS = BigInt(
  MAX_TRANSACTION_AMOUNT_IN_CENTS,
);
const ONE_HUNDRED_MINOR_UNITS = BigInt(100);
const ZERO_MINOR_UNITS = BigInt(0);
const UNGROUPED_MONEY_INPUT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const GROUPED_MONEY_INPUT_PATTERN =
  /^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,2})?$/;

type MoneyInputErrorReason = "format" | "non-positive" | "too-large";
type MoneyTransactionType = "ADD" | "REMOVE";

export class MoneyInputError extends Error {
  constructor(public readonly reason: MoneyInputErrorReason) {
    super("Invalid amount.");
    this.name = "MoneyInputError";
  }
}

export class MoneyAggregateOverflowError extends Error {
  constructor() {
    super("Transaction totals exceed the supported range.");
    this.name = "MoneyAggregateOverflowError";
  }
}

export function parseMoneyToMinorUnits(value: string) {
  if (value.length > MAX_MONEY_INPUT_LENGTH) {
    throw new MoneyInputError("too-large");
  }

  const input = value.trim();

  if (
    !UNGROUPED_MONEY_INPUT_PATTERN.test(input) &&
    !GROUPED_MONEY_INPUT_PATTERN.test(input)
  ) {
    throw new MoneyInputError("format");
  }

  const normalized = input.replaceAll(",", "");
  const [wholePart, decimalPart = ""] = normalized.split(".");
  const paddedDecimalPart = decimalPart.padEnd(2, "0");
  const amountInCents =
    BigInt(wholePart) * ONE_HUNDRED_MINOR_UNITS +
    BigInt(paddedDecimalPart || "0");

  if (amountInCents <= ZERO_MINOR_UNITS) {
    throw new MoneyInputError("non-positive");
  }

  if (amountInCents > MAX_TRANSACTION_AMOUNT_IN_MINOR_UNITS) {
    throw new MoneyInputError("too-large");
  }

  return Number(amountInCents);
}

export function getMoneyInputErrorReason(value: string) {
  try {
    parseMoneyToMinorUnits(value);
    return null;
  } catch (error) {
    if (error instanceof MoneyInputError) {
      return error.reason;
    }

    throw error;
  }
}

export function formatCurrencyFromMinorUnits(amountInCents: number) {
  return moneyFormatter.format(amountInCents / 100);
}

export function formatSignedCurrency(
  amountInCents: number,
  type: MoneyTransactionType,
) {
  const sign = type === "ADD" ? "+" : "-";

  return `${sign}${formatCurrencyFromMinorUnits(amountInCents)}`;
}

export function calculateBalanceInCents(
  totals: Array<{
    type: MoneyTransactionType;
    amountInCents: number;
  }>,
) {
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const entry of totals) {
    if (
      !Number.isSafeInteger(entry.amountInCents) ||
      entry.amountInCents < 0
    ) {
      throw new MoneyAggregateOverflowError();
    }

    if (entry.type === "ADD") {
      totalAdded += entry.amountInCents;

      if (!Number.isSafeInteger(totalAdded)) {
        throw new MoneyAggregateOverflowError();
      }
    } else {
      totalRemoved += entry.amountInCents;

      if (!Number.isSafeInteger(totalRemoved)) {
        throw new MoneyAggregateOverflowError();
      }
    }
  }

  const balanceInCents = totalAdded - totalRemoved;

  if (!Number.isSafeInteger(balanceInCents)) {
    throw new MoneyAggregateOverflowError();
  }

  return balanceInCents;
}
