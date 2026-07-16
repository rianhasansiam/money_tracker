import { describe, expect, it } from "vitest";
import {
  MAX_TRANSACTION_AMOUNT_IN_CENTS,
  MoneyAggregateOverflowError,
  MoneyInputError,
  calculateBalanceInCents,
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
