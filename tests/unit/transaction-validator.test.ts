import { describe, expect, it } from "vitest";
import {
  getTransactionFormDefaults,
  transactionFormSchema,
} from "@/lib/validators/transaction";

const validInput = {
  amount: "1,000.50",
  note: "Office supplies",
  type: "ADD" as const,
  transactionDate: "2024-02-29",
};

function getFirstFieldError(
  input: unknown,
  field: "amount" | "transactionDate",
) {
  const result = transactionFormSchema.safeParse(input);

  if (result.success) {
    throw new Error("Expected transaction validation to fail.");
  }

  return result.error.flatten().fieldErrors[field]?.[0];
}

describe("transactionFormSchema", () => {
  it("accepts and trims a valid transaction", () => {
    expect(
      transactionFormSchema.parse({
        ...validInput,
        amount: " 1,000.50 ",
        note: " Office supplies ",
      }),
    ).toEqual(validInput);
  });

  it("returns field-specific money errors", () => {
    expect(getFirstFieldError({ ...validInput, amount: "1,2" }, "amount")).toBe(
      "Use digits with optional 3-digit comma groups and up to two decimal places.",
    );
    expect(
      getFirstFieldError(
        { ...validInput, amount: "21,474,836.48" },
        "amount",
      ),
    ).toBe("Amount cannot exceed 21,474,836.47 BDT.");
    expect(getFirstFieldError({ ...validInput, amount: "0" }, "amount")).toBe(
      "Amount must be greater than zero.",
    );
    expect(
      getFirstFieldError(
        { ...validInput, amount: `${" ".repeat(32)}1` },
        "amount",
      ),
    ).toBe("Amount must be 32 characters or fewer.");
  });

  it("returns field-specific calendar errors", () => {
    expect(
      getFirstFieldError(
        { ...validInput, transactionDate: "2024-02-30" },
        "transactionDate",
      ),
    ).toBe("Use a real calendar date.");
    expect(
      getFirstFieldError(
        { ...validInput, transactionDate: "2024/02/29" },
        "transactionDate",
      ),
    ).toBe("Use a date in YYYY-MM-DD format.");
    expect(
      getFirstFieldError(
        { ...validInput, transactionDate: "9999-12-31" },
        "transactionDate",
      ),
    ).toBe("Created date cannot be in the future.");
  });

  it("rejects unknown form fields", () => {
    expect(
      transactionFormSchema.safeParse({ ...validInput, unexpected: true }).success,
    ).toBe(false);
  });

  it("creates defaults from Dhaka business time", () => {
    expect(
      getTransactionFormDefaults(new Date("2026-07-14T18:00:00.000Z")),
    ).toEqual({
      amount: "",
      note: "",
      type: "ADD",
      transactionDate: "2026-07-15",
    });
  });
});
