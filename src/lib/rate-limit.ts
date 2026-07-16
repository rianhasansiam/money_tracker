import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { db } from "@/lib/db";

const RATE_LIMIT_SCOPE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const MAX_RATE_LIMIT = 10_000;
const MAX_WINDOW_SECONDS = 86_400;

export type TrustedProxyMode = "cloudflare" | "forwarded" | "vercel";

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface UserRateLimitInput {
  scope: string;
  userId: string;
  limit: number;
  windowSeconds: number;
}

export interface IpRateLimitInput {
  scope: string;
  ip: string;
  limit: number;
  windowSeconds: number;
}

interface RateLimitStore {
  rateLimitBucket: {
    upsert(input: {
      where: {
        scope_subjectHash_windowStart: {
          scope: string;
          subjectHash: string;
          windowStart: Date;
        };
      };
      create: {
        scope: string;
        subjectHash: string;
        windowStart: Date;
        count: number;
        expiresAt: Date;
      };
      update: {
        count: { increment: number };
        expiresAt: Date;
      };
      select: { count: true };
    }): Promise<{ count: number }>;
  };
}

interface RateLimitDependencies {
  now?: Date;
  secret?: string;
  store?: RateLimitStore;
}

export class RateLimitUnavailableError extends Error {
  constructor() {
    super("The rate-limit service is unavailable.");
    this.name = "RateLimitUnavailableError";
  }
}

export class RateLimitExceededError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("The rate limit was exceeded.");
    this.name = "RateLimitExceededError";
  }
}

function getRateLimitSecret(override?: string) {
  const secret =
    override ?? process.env.RATE_LIMIT_HASH_SECRET ?? process.env.AUTH_SECRET;

  if (!secret || secret.length < 16) {
    throw new RateLimitUnavailableError();
  }

  return secret;
}

function validateRateLimitConfiguration(
  scope: string,
  subject: string,
  limit: number,
  windowSeconds: number,
) {
  if (
    !RATE_LIMIT_SCOPE_PATTERN.test(scope) ||
    subject.length === 0 ||
    subject.length > 512 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_RATE_LIMIT ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > MAX_WINDOW_SECONDS
  ) {
    throw new RateLimitUnavailableError();
  }
}

function hashSubject(kind: "ip" | "user", subject: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${kind}:${subject}`, "utf8")
    .digest("hex");
}

async function consumeRateLimit(
  input: {
    kind: "ip" | "user";
    scope: string;
    subject: string;
    limit: number;
    windowSeconds: number;
  },
  dependencies: RateLimitDependencies = {},
): Promise<RateLimitDecision> {
  validateRateLimitConfiguration(
    input.scope,
    input.subject,
    input.limit,
    input.windowSeconds,
  );

  const now = dependencies.now ?? new Date();
  const nowMilliseconds = now.getTime();

  if (!Number.isFinite(nowMilliseconds)) {
    throw new RateLimitUnavailableError();
  }

  const windowMilliseconds = input.windowSeconds * 1_000;
  const windowStartMilliseconds =
    Math.floor(nowMilliseconds / windowMilliseconds) * windowMilliseconds;
  const windowStart = new Date(windowStartMilliseconds);
  const expiresAt = new Date(windowStartMilliseconds + windowMilliseconds);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((expiresAt.getTime() - nowMilliseconds) / 1_000),
  );
  const secret = getRateLimitSecret(dependencies.secret);
  const subjectHash = hashSubject(input.kind, input.subject, secret);
  const store = dependencies.store ?? (db as unknown as RateLimitStore);

  let bucket: { count: number };

  try {
    bucket = await store.rateLimitBucket.upsert({
      where: {
        scope_subjectHash_windowStart: {
          scope: input.scope,
          subjectHash,
          windowStart,
        },
      },
      create: {
        scope: input.scope,
        subjectHash,
        windowStart,
        count: 1,
        expiresAt,
      },
      update: {
        count: {
          increment: 1,
        },
        expiresAt,
      },
      select: {
        count: true,
      },
    });
  } catch {
    throw new RateLimitUnavailableError();
  }

  if (!Number.isSafeInteger(bucket.count) || bucket.count < 1) {
    throw new RateLimitUnavailableError();
  }

  return {
    allowed: bucket.count <= input.limit,
    limit: input.limit,
    remaining: Math.max(0, input.limit - bucket.count),
    retryAfterSeconds: bucket.count <= input.limit ? 0 : retryAfterSeconds,
  };
}

export async function checkUserRateLimit(
  input: UserRateLimitInput,
  dependencies: RateLimitDependencies = {},
) {
  return consumeRateLimit(
    {
      kind: "user",
      scope: input.scope,
      subject: input.userId,
      limit: input.limit,
      windowSeconds: input.windowSeconds,
    },
    dependencies,
  );
}

export async function enforceUserRateLimit(
  input: UserRateLimitInput,
  dependencies: RateLimitDependencies = {},
) {
  const decision = await checkUserRateLimit(input, dependencies);

  if (!decision.allowed) {
    throw new RateLimitExceededError(decision.retryAfterSeconds);
  }

  return decision;
}

export async function checkIpRateLimit(
  input: IpRateLimitInput,
  dependencies: RateLimitDependencies = {},
) {
  if (isIP(input.ip) === 0) {
    throw new RateLimitUnavailableError();
  }

  return consumeRateLimit(
    {
      kind: "ip",
      scope: input.scope,
      subject: input.ip.toLowerCase(),
      limit: input.limit,
      windowSeconds: input.windowSeconds,
    },
    dependencies,
  );
}

export async function enforceIpRateLimit(
  input: IpRateLimitInput,
  dependencies: RateLimitDependencies = {},
) {
  const decision = await checkIpRateLimit(input, dependencies);

  if (!decision.allowed) {
    throw new RateLimitExceededError(decision.retryAfterSeconds);
  }

  return decision;
}

function parseSingleIp(value: string | null | undefined) {
  const candidate = value?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate.toLowerCase() : null;
}

function parseForwardedFor(value: string | null | undefined) {
  const firstHop = value?.split(",", 1)[0];
  return parseSingleIp(firstHop);
}

export function getTrustedClientIp(input: {
  headers: Pick<Headers, "get">;
  peerIp?: string | null;
  proxyMode?: TrustedProxyMode | null;
}) {
  if (input.proxyMode === "cloudflare") {
    return (
      parseSingleIp(input.headers.get("cf-connecting-ip")) ??
      parseSingleIp(input.peerIp)
    );
  }

  if (input.proxyMode === "forwarded" || input.proxyMode === "vercel") {
    return (
      parseForwardedFor(input.headers.get("x-forwarded-for")) ??
      parseSingleIp(input.peerIp)
    );
  }

  return parseSingleIp(input.peerIp);
}

export function getConfiguredTrustedClientIp(
  headers: Pick<Headers, "get">,
  peerIp?: string | null,
) {
  const configuredMode = process.env.TRUSTED_PROXY_MODE;
  const proxyMode: TrustedProxyMode | null =
    configuredMode === "cloudflare" ||
    configuredMode === "forwarded" ||
    configuredMode === "vercel"
      ? configuredMode
      : null;

  return getTrustedClientIp({
    headers,
    peerIp,
    proxyMode,
  });
}
