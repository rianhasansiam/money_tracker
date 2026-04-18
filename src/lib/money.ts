import type { DashboardTransactionType } from "@/lib/queries/dashboard";

const moneyFormatter = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("en-BD", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const MONEY_INPUT_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export function normalizeMoneyInput(value: string | number) {
  return String(value).replaceAll(",", "").trim();
}

export function parseMoneyToMinorUnits(value: string | number) {
  const normalized = normalizeMoneyInput(value);

  if (!MONEY_INPUT_PATTERN.test(normalized)) {
    throw new Error("Invalid amount.");
  }

  const [wholePart, decimalPart = ""] = normalized.split(".");
  const paddedDecimalPart = `${decimalPart}00`.slice(0, 2);
  const amountInCents = Number(wholePart) * 100 + Number(paddedDecimalPart);

  if (!Number.isSafeInteger(amountInCents) || amountInCents <= 0) {
    throw new Error("Invalid amount.");
  }

  return amountInCents;
}

export function isValidMoneyInput(value: string | number) {
  try {
    return parseMoneyToMinorUnits(value) > 0;
  } catch {
    return false;
  }
}

export function formatCurrencyFromMinorUnits(amountInCents: number) {
  return moneyFormatter.format(amountInCents / 100);
}

export function formatSignedCurrency(
  amountInCents: number,
  type: DashboardTransactionType,
) {
  const sign = type === "ADD" ? "+" : "-";

  return `${sign}${formatCurrencyFromMinorUnits(amountInCents)}`;
}

export function calculateBalanceInCents(
  totals: Array<{
    type: DashboardTransactionType;
    amountInCents: number;
  }>,
) {
  const totalAdded = totals
    .filter((entry) => entry.type === "ADD")
    .reduce((sum, entry) => sum + entry.amountInCents, 0);

  const totalRemoved = totals
    .filter((entry) => entry.type === "REMOVE")
    .reduce((sum, entry) => sum + entry.amountInCents, 0);

  return totalAdded - totalRemoved;
}

export function getTodayDateInputValue(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

export function isFutureDateInput(value: string) {
  return value > getTodayDateInputValue();
}

export function parseDateInput(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new Error("Invalid date.");
  }

  const [, year, month, day] = match;
  const parsedDate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getUTCFullYear() !== Number(year) ||
    parsedDate.getUTCMonth() !== Number(month) - 1 ||
    parsedDate.getUTCDate() !== Number(day)
  ) {
    throw new Error("Invalid date.");
  }

  return parsedDate;
}

export function formatTransactionDate(value: Date | string) {
  return dateFormatter.format(new Date(value));
}
