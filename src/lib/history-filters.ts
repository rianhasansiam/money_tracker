import { z } from "zod";
import {
  getBusinessTodayDateInputValue,
  isValidCalendarDateInput,
} from "@/lib/date-time";

export const MAX_HISTORY_SEARCH_LENGTH = 120;
const directions = ["ALL", "ADD", "REMOVE"] as const;
const periods = ["ALL", "THIS_MONTH", "LAST_MONTH", "CUSTOM"] as const;

export interface HistoryFilterInput {
  search?: string;
  direction?: (typeof directions)[number];
  period?: (typeof periods)[number];
  from?: string | null;
  to?: string | null;
}

/** Calendar bounds are inclusive, resolved using one Asia/Dhaka instant. */
export interface HistoryFilters {
  search: string;
  direction: (typeof directions)[number];
  period: (typeof periods)[number];
  from: string | null;
  to: string | null;
}

export type HistoryFilterFieldErrors = Partial<Record<keyof HistoryFilterInput, string>>;

export class InvalidHistoryFiltersError extends Error {
  constructor(public readonly fieldErrors: HistoryFilterFieldErrors) {
    super("Review the transaction history filters.");
    this.name = "InvalidHistoryFiltersError";
  }
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  search: "",
  direction: "ALL",
  period: "ALL",
  from: null,
  to: null,
};

const optionalCalendarDate = z.string().trim().max(10, "Use YYYY-MM-DD.")
  .refine((value) => value === "" || isValidCalendarDateInput(value), "Use a real date in YYYY-MM-DD format.")
  .nullable().optional();

const inputSchema = z.object({
  search: z.string().max(256, "Search must be 120 characters or fewer.").trim()
    .max(MAX_HISTORY_SEARCH_LENGTH, "Search must be 120 characters or fewer.")
    .refine((value) => !value.includes("\0"), "Search cannot contain null characters.").default(""),
  direction: z.enum(directions, { error: "Choose all, money added, or money removed." }).default("ALL"),
  period: z.enum(periods, { error: "Choose an available date period." }).default("ALL"),
  from: optionalCalendarDate,
  to: optionalCalendarDate,
}).strict();

function calendarDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Literal, case-insensitive note substring; %, _ and backslash are plain text. */
export function normalizeHistoryFilters(input: unknown = {}, instant = new Date()): HistoryFilters {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const errors: HistoryFilterFieldErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof HistoryFilterInput | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
    throw new InvalidHistoryFiltersError(errors);
  }
  const { search, direction, period } = parsed.data;
  const today = getBusinessTodayDateInputValue(instant);
  const [year, month] = today.split("-").map(Number);
  let from: string | null = null;
  let to: string | null = null;

  if (period === "THIS_MONTH") {
    from = calendarDate(year, month, 1);
    to = today;
  } else if (period === "LAST_MONTH") {
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousYear = month === 1 ? year - 1 : year;
    // The business calendar supported by the ledger starts at year 0001.
    if (previousYear < 1) throw new InvalidHistoryFiltersError({ period: "There is no earlier supported calendar month." });
    from = calendarDate(previousYear, previousMonth, 1);
    const end = new Date(0);
    end.setUTCFullYear(year, month - 1, 0);
    to = calendarDate(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate());
  } else if (period === "CUSTOM") {
    from = parsed.data.from || null;
    to = parsed.data.to || null;
    const errors: HistoryFilterFieldErrors = {};
    if (!from) errors.from = "Choose a start date.";
    if (!to) errors.to = "Choose an end date.";
    if (from && to && from > to) errors.to = "The end date must be on or after the start date.";
    if (from && from > today) errors.from = "The start date cannot be after today in Asia/Dhaka.";
    if (to && to > today) errors.to = "The end date cannot be after today in Asia/Dhaka.";
    if (Object.keys(errors).length) throw new InvalidHistoryFiltersError(errors);
  }
  return { search, direction, period, from, to };
}

export function hasHistoryFilters(filters: HistoryFilters) {
  return filters.search.length > 0 || filters.direction !== "ALL" || filters.period !== "ALL";
}

/** Only non-sensitive navigation state belongs in the URL. Search stays in memory. */
export function historyFilterNavigationSearch(filters: HistoryFilters) {
  const params = new URLSearchParams();
  if (filters.direction !== "ALL") params.set("direction", filters.direction);
  if (filters.period !== "ALL") params.set("period", filters.period);
  if (filters.period === "CUSTOM") {
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
  }
  return params.toString();
}

export function historyFiltersFromSearchParams(
  params: Record<string, string | string[] | undefined>,
  instant = new Date(),
) {
  return normalizeHistoryFilters({
    direction: params.direction,
    period: params.period,
    from: params.from,
    to: params.to,
  }, instant);
}
