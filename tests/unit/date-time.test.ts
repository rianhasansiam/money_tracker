import { describe, expect, it } from "vitest";
import {
  formatTimestampInBusinessTimeZone,
  formatTransactionDateOnly,
  getBusinessTodayDateInputValue,
  isFutureTransactionDate,
  isValidCalendarDateInput,
  parseTransactionDateInput,
  toTransactionDateInputValue,
} from "@/lib/date-time";

describe("calendar date validation", () => {
  it.each(["2024-02-29", "2000-02-29", "2026-07-15"])(
    "accepts real calendar date %s",
    (value) => {
      expect(isValidCalendarDateInput(value)).toBe(true);
    },
  );

  it.each([
    "2023-02-29",
    "1900-02-29",
    "2024-02-30",
    "2024-00-10",
    "2024-13-10",
    "2024-04-31",
    "0000-01-01",
    "2024-1-01",
  ])("rejects impossible or malformed date %s", (value) => {
    expect(isValidCalendarDateInput(value)).toBe(false);
    expect(() => parseTransactionDateInput(value)).toThrow(
      "Invalid transaction date.",
    );
  });

  it("round-trips a date-only value through the Prisma Date boundary", () => {
    const databaseDate = parseTransactionDateInput("2024-02-29");

    expect(databaseDate.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(toTransactionDateInputValue(databaseDate)).toBe("2024-02-29");
  });
});

describe("Asia/Dhaka date policy", () => {
  const beforeDhakaMidnight = new Date("2026-07-14T17:59:59.999Z");
  const atDhakaMidnight = new Date("2026-07-14T18:00:00.000Z");

  it("changes business today at Dhaka midnight rather than UTC midnight", () => {
    expect(getBusinessTodayDateInputValue(beforeDhakaMidnight)).toBe(
      "2026-07-14",
    );
    expect(getBusinessTodayDateInputValue(atDhakaMidnight)).toBe("2026-07-15");
  });

  it("compares future dates against the Dhaka business date", () => {
    expect(isFutureTransactionDate("2026-07-15", beforeDhakaMidnight)).toBe(
      true,
    );
    expect(isFutureTransactionDate("2026-07-15", atDhakaMidnight)).toBe(false);
  });

  it("formats date-only values separately from timestamp instants", () => {
    expect(formatTimestampInBusinessTimeZone(beforeDhakaMidnight)).toBe(
      formatTransactionDateOnly("2026-07-14"),
    );
    expect(formatTimestampInBusinessTimeZone(atDhakaMidnight)).toBe(
      formatTransactionDateOnly("2026-07-15"),
    );
  });
});
