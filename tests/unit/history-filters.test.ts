import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_FILTERS,
  InvalidHistoryFiltersError,
  hasHistoryFilters,
  historyFilterNavigationSearch,
  historyFiltersFromSearchParams,
  normalizeHistoryFilters,
} from "@/lib/history-filters";

const now = new Date("2026-11-17T05:00:00.000Z");

describe("normalized transaction discovery filters", () => {
  it("defaults to the complete ledger and retains literal search characters", () => {
    expect(normalizeHistoryFilters({}, now)).toEqual(DEFAULT_HISTORY_FILTERS);
    expect(normalizeHistoryFilters({ search: "  50%_\\receipt  " }, now)).toMatchObject({ search: "50%_\\receipt" });
    expect(hasHistoryFilters(DEFAULT_HISTORY_FILTERS)).toBe(false);
    expect(hasHistoryFilters(normalizeHistoryFilters({ search: "receipt" }, now))).toBe(true);
  });

  it.each([
    ["2026-10-31T17:59:59.999Z", "2026-10-01", "2026-10-31"],
    ["2026-10-31T18:00:00.000Z", "2026-11-01", "2026-11-01"],
  ])("resolves this month at the Dhaka boundary %s", (instant, from, to) => {
    expect(normalizeHistoryFilters({ period: "THIS_MONTH" }, new Date(instant))).toMatchObject({ from, to });
  });

  it.each([
    ["2024-02-29T18:00:00.000Z", "2024-02-01", "2024-02-29"],
    ["2025-01-01T01:00:00.000Z", "2024-12-01", "2024-12-31"],
  ])("resolves the preceding calendar month %s", (instant, from, to) => {
    expect(normalizeHistoryFilters({ period: "LAST_MONTH" }, new Date(instant))).toMatchObject({ from, to });
  });

  it("preserves ancient dates and makes custom boundaries inclusive", () => {
    expect(normalizeHistoryFilters({ period: "CUSTOM", from: "0001-01-01", to: "0099-12-31" }, now)).toMatchObject({ from: "0001-01-01", to: "0099-12-31" });
    expect(normalizeHistoryFilters({ period: "CUSTOM", from: "2026-11-17", to: "2026-11-17" }, now)).toMatchObject({ from: "2026-11-17", to: "2026-11-17" });
  });

  it.each([
    { search: "x".repeat(121) },
    { search: " ".repeat(257) },
    { search: "invalid\0query" },
    { direction: "WRITER" },
    { period: "WEEK" },
    { period: "CUSTOM", from: "2024-02-30", to: "2026-11-17" },
    { period: "CUSTOM", from: "2026-11-17" },
    { period: "CUSTOM", from: "2026-11-17", to: "2026-11-16" },
    { period: "CUSTOM", from: "2026-11-17", to: "2026-11-18" },
    { period: "CUSTOM", from: "0000-01-01", to: "2026-11-17" },
    { from: "not-a-date" },
    { unexpected: "field" },
  ])("rejects invalid filters rather than silently reading unfiltered data: %j", (input) => {
    expect(() => normalizeHistoryFilters(input, now)).toThrow(InvalidHistoryFiltersError);
  });

  it("serializes safe navigation state without private search text", () => {
    const filters = normalizeHistoryFilters({ search: "private receipt", direction: "REMOVE", period: "CUSTOM", from: "2026-01-01", to: "2026-11-17" }, now);
    const query = historyFilterNavigationSearch(filters);
    expect(query).toBe("direction=REMOVE&period=CUSTOM&from=2026-01-01&to=2026-11-17");
    expect(query).not.toContain("private");
    expect(historyFiltersFromSearchParams({ direction: "REMOVE", period: "CUSTOM", from: "2026-01-01", to: "2026-11-17", search: "must not hydrate from URL" }, now)).toEqual({ ...filters, search: "" });
    expect(() => historyFiltersFromSearchParams({ direction: ["ADD", "REMOVE"] }, now)).toThrow(InvalidHistoryFiltersError);
  });
});
