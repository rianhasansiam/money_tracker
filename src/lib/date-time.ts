const BUSINESS_TIME_ZONE = "Asia/Dhaka";

const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const businessDatePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  calendar: "gregory",
  numberingSystem: "latn",
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const transactionDateFormatter = new Intl.DateTimeFormat("en-BD", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const businessTimestampFormatter = new Intl.DateTimeFormat("en-BD", {
  dateStyle: "medium",
  timeZone: BUSINESS_TIME_ZONE,
});

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function getDaysInMonth(year: number, month: number) {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseCalendarDateParts(value: string): CalendarDateParts | null {
  const match = DATE_INPUT_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > getDaysInMonth(year, month)
  ) {
    return null;
  }

  return { year, month, day };
}

function createUtcDate({ year, month, day }: CalendarDateParts) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function padDatePart(value: number, length = 2) {
  return String(value).padStart(length, "0");
}

function getFormattedPart(parts: Intl.DateTimeFormatPart[], type: string) {
  const value = parts.find((part) => part.type === type)?.value;

  if (!value) {
    throw new Error(`Could not determine the ${type} in ${BUSINESS_TIME_ZONE}.`);
  }

  return value;
}

export function isValidCalendarDateInput(value: string) {
  return parseCalendarDateParts(value) !== null;
}

export function getBusinessTodayDateInputValue(instant = new Date()) {
  if (Number.isNaN(instant.getTime())) {
    throw new Error("Invalid instant.");
  }

  const parts = businessDatePartsFormatter.formatToParts(instant);
  const year = getFormattedPart(parts, "year");
  const month = getFormattedPart(parts, "month");
  const day = getFormattedPart(parts, "day");

  return `${year}-${month}-${day}`;
}

export function isFutureTransactionDate(value: string, instant = new Date()) {
  return value > getBusinessTodayDateInputValue(instant);
}

export function parseTransactionDateInput(value: string) {
  const parts = parseCalendarDateParts(value);

  if (!parts) {
    throw new Error("Invalid transaction date.");
  }

  return createUtcDate(parts);
}

export function toTransactionDateInputValue(value: Date) {
  if (Number.isNaN(value.getTime())) {
    throw new Error("Invalid transaction date.");
  }

  return [
    padDatePart(value.getUTCFullYear(), 4),
    padDatePart(value.getUTCMonth() + 1),
    padDatePart(value.getUTCDate()),
  ].join("-");
}

export function formatTransactionDateOnly(value: string) {
  return transactionDateFormatter.format(parseTransactionDateInput(value));
}

export function formatTimestampInBusinessTimeZone(value: Date | string) {
  const instant = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(instant.getTime())) {
    throw new Error("Invalid timestamp.");
  }

  return businessTimestampFormatter.format(instant);
}
