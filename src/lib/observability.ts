export const SERVER_ERROR_CATEGORY = {
  authentication: "authentication",
  authorization: "authorization",
  configuration: "configuration",
  conflict: "conflict",
  dataAccess: "data_access",
  dependencyUnavailable: "dependency_unavailable",
  lifecycle: "lifecycle",
  rateLimit: "rate_limit",
  security: "security",
  unexpected: "unexpected",
  validation: "validation",
} as const;

export type ServerErrorCategory =
  (typeof SERVER_ERROR_CATEGORY)[keyof typeof SERVER_ERROR_CATEGORY];

type LogLevel = "error" | "info" | "warn";

interface ServerLogOptions {
  correlationId?: string;
  context?: Record<string, unknown>;
}

interface SerializedError {
  code?: string;
  digest?: string;
  name: string;
}

const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z0-9_-]{1,32}$/;
const SAFE_DIGEST_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|credential|secret|password|session[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth|database[_-]?url|connection[_-]?string|financial[_-]?note|transaction[_-]?note|\bnote\b|\bemail\b)/i;
const IDENTIFIER_KEY_PATTERN =
  /(?:^|[_-])(?:user|team|account|session|membership|transaction|invitation|actor)(?:[_-]?id)?$/i;
const FINANCIAL_VALUE_KEY_PATTERN =
  /(?:amount|balance|credit|debit|income|expense|cents|minor[_-]?units)/i;
const DATABASE_URL_PATTERN =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_PARAMETER_PATTERN =
  /\b(?:access_token|refresh_token|id_token|client_secret)=([^&\s]+)/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MAX_STRING_LENGTH = 512;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_DEPTH = 5;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function sanitizeString(value: string) {
  const sanitized = value
    .replace(DATABASE_URL_PATTERN, "[DATABASE_URL_REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(TOKEN_PARAMETER_PATTERN, (match) => {
      const separatorIndex = match.indexOf("=");
      return `${match.slice(0, separatorIndex + 1)}[REDACTED]`;
    })
    .replace(EMAIL_PATTERN, "[EMAIL_REDACTED]");

  if (sanitized.length <= MAX_STRING_LENGTH) {
    return sanitized;
  }

  return `${sanitized.slice(0, MAX_STRING_LENGTH)}[TRUNCATED]`;
}

function redactValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (IDENTIFIER_KEY_PATTERN.test(key)) {
    return "[IDENTIFIER_REDACTED]";
  }

  if (FINANCIAL_VALUE_KEY_PATTERN.test(key)) {
    return "[FINANCIAL_VALUE_REDACTED]";
  }

  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return "[BIGINT_REDACTED]";
  }

  if (typeof value !== "object") {
    return `[${typeof value === "symbol" ? "SYMBOL" : "FUNCTION"}]`;
  }

  if (depth >= MAX_OBJECT_DEPTH) {
    return "[MAX_DEPTH]";
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }

  seen.add(value);

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, "", depth + 1, seen));
  }

  const redacted: Record<string, unknown> = {};

  for (const [entryKey, entryValue] of Object.entries(value)) {
    redacted[entryKey] = redactValue(
      entryValue,
      entryKey,
      depth + 1,
      seen,
    );
  }

  return redacted;
}

function readSafeStringProperty(
  value: object,
  property: "code" | "digest" | "name",
) {
  if (!(property in value)) {
    return undefined;
  }

  const candidate = Reflect.get(value, property);
  return typeof candidate === "string" ? candidate : undefined;
}

function serializeError(error: unknown): SerializedError {
  if (typeof error !== "object" || error === null) {
    return { name: "UnknownThrownValue" };
  }

  const name = readSafeStringProperty(error, "name");
  const code = readSafeStringProperty(error, "code");
  const digest = readSafeStringProperty(error, "digest");
  const result: SerializedError = {
    name:
      name && /^[A-Za-z0-9_.-]{1,96}$/.test(name)
        ? name
        : "UnknownError",
  };

  if (code && SAFE_ERROR_CODE_PATTERN.test(code)) {
    result.code = code;
  }

  if (digest && SAFE_DIGEST_PATTERN.test(digest)) {
    result.digest = digest;
  }

  return result;
}

function normalizeCorrelationId(candidate?: string) {
  return candidate && CORRELATION_ID_PATTERN.test(candidate)
    ? candidate
    : createCorrelationId();
}

function getServiceName() {
  const configuredName = process.env.OTEL_SERVICE_NAME;
  return configuredName && SERVICE_NAME_PATTERN.test(configuredName)
    ? configuredName
    : "money-tracker";
}

export function createCorrelationId() {
  return globalThis.crypto.randomUUID();
}

export function redactSensitiveValue(value: unknown, key = "") {
  try {
    return redactValue(value, key, 0, new WeakSet<object>());
  } catch {
    return "[UNSERIALIZABLE_REDACTED]";
  }
}

export function logServerEvent(
  level: LogLevel,
  category: ServerErrorCategory,
  event: string,
  options: ServerLogOptions = {},
) {
  const correlationId = normalizeCorrelationId(options.correlationId);
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: getServiceName(),
    category,
    event: sanitizeString(event),
    correlationId,
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    ...(options.context
      ? { context: redactSensitiveValue(options.context) }
      : {}),
  };
  const serializedRecord = JSON.stringify(record);

  try {
    if (level === "error") {
      console.error(serializedRecord);
    } else if (level === "warn") {
      console.warn(serializedRecord);
    } else {
      console.info(serializedRecord);
    }
  } catch {
    // Logging must never change the application's control flow.
  }

  return correlationId;
}

export function logServerError(
  category: ServerErrorCategory,
  error: unknown,
  options: ServerLogOptions = {},
) {
  return logServerEvent("error", category, "server_error", {
    ...options,
    context: {
      ...options.context,
      error: serializeError(error),
    },
  });
}

export function formatPublicErrorReference(correlationId: string) {
  const safeCorrelationId = normalizeCorrelationId(correlationId);
  return `Something went wrong. Try again later. Reference: ${safeCorrelationId}.`;
}

export function reportUnexpectedError(
  error: unknown,
  options: Omit<ServerLogOptions, "correlationId"> & {
    category?: ServerErrorCategory;
    correlationId?: string;
  } = {},
) {
  const correlationId = logServerError(
    options.category ?? SERVER_ERROR_CATEGORY.unexpected,
    error,
    options,
  );

  return {
    correlationId,
    message: formatPublicErrorReference(correlationId),
  };
}
