import { describe, expect, it } from "vitest";
import {
  MAX_TRANSACTION_AMOUNT_IN_CENTS,
  MoneyAggregateOverflowError,
  MoneyInputError,
  calculateBalanceInCents,
  formatCurrencyFromMinorUnits,
  formatSignedCurrency,
  getMoneyInputErrorReason,
  parseMoneyToMinorUnits,
} from "@/lib/money";

describe("parseMoneyToMinorUnits", () => {
  it.each([
    ["1", 100],
    ["0.01", 1],
    ["1000.50", 100_050],
    ["1,000.50", 100_050],
    ["21,474,836.47", MAX_TRANSACTION_AMOUNT_IN_CENTS],
    [" 1,000.50 ", 100_050],
  ])("parses the supported amount %s", (input, expected) => {
    expect(parseMoneyToMinorUnits(input)).toBe(expected);
  });

  it.each([
    "",
    "01.00",
    ".50",
    "1,2",
    "1,,000",
    "12,34,567",
    "1,000,00",
    "1.00,0",
    "1,000.000",
    "1 000",
    "1_000",
    "1e3",
    "+1",
    "-1",
  ])("rejects malformed amount %s", (input) => {
    expect(() => parseMoneyToMinorUnits(input)).toThrow(MoneyInputError);
    expect(getMoneyInputErrorReason(input)).toBe("format");
  });

  it("distinguishes non-positive and out-of-range values", () => {
    expect(getMoneyInputErrorReason("0.00")).toBe("non-positive");
    expect(getMoneyInputErrorReason("21,474,836.48")).toBe("too-large");
    expect(getMoneyInputErrorReason("9".repeat(33))).toBe("too-large");
    expect(getMoneyInputErrorReason(`${" ".repeat(32)}1`)).toBe("too-large");
  });
});

describe("exact currency formatting", () => {
  it.each([
    [0, "BDT\u00a00.00"],
    [1, "BDT\u00a00.01"],
    [-1, "-BDT\u00a00.01"],
    [-0, "-BDT\u00a00.00"],
    [123_456, "BDT\u00a01,234.56"],
    [-123_456, "-BDT\u00a01,234.56"],
    [MAX_TRANSACTION_AMOUNT_IN_CENTS, "BDT\u00a021,474,836.47"],
    [Number.MAX_SAFE_INTEGER, "BDT\u00a090,071,992,547,409.91"],
    [-Number.MAX_SAFE_INTEGER, "-BDT\u00a090,071,992,547,409.91"],
    [Number.MAX_SAFE_INTEGER - 1, "BDT\u00a090,071,992,547,409.90"],
  ])("formats %s cents with its exact fraction and locale", (amount, expected) => {
    expect(formatCurrencyFromMinorUnits(amount)).toBe(expected);
  });

  it("preserves transaction direction independently of currency formatting", () => {
    expect(formatSignedCurrency(Number.MAX_SAFE_INTEGER, "ADD")).toBe(
      "+BDT\u00a090,071,992,547,409.91",
    );
    expect(formatSignedCurrency(Number.MAX_SAFE_INTEGER, "REMOVE")).toBe(
      "-BDT\u00a090,071,992,547,409.91",
    );
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, 1.5])(
    "does not widen the supported integer-cent range for %s",
    (amount) => {
      expect(() => formatCurrencyFromMinorUnits(amount)).toThrow(
        MoneyAggregateOverflowError,
      );
    },
  );
});

describe("calculateBalanceInCents", () => {
  it("calculates a checked balance", () => {
    expect(
      calculateBalanceInCents([
        { type: "ADD", amountInCents: 10_000 },
        { type: "REMOVE", amountInCents: 2_500 },
      ]),
    ).toBe(7_500);
  });

  it("rejects unsafe aggregate arithmetic", () => {
    expect(() =>
      calculateBalanceInCents([
        { type: "ADD", amountInCents: Number.MAX_SAFE_INTEGER },
        { type: "ADD", amountInCents: 1 },
      ]),
    ).toThrow(MoneyAggregateOverflowError);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid aggregate value %s",
    (amountInCents) => {
      expect(() =>
        calculateBalanceInCents([{ type: "ADD", amountInCents }]),
      ).toThrow(MoneyAggregateOverflowError);
    },
  );
});
