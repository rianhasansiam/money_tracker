import { beforeEach, describe, expect, it, vi } from "vitest";

const rateLimitMocks = vi.hoisted(() => ({
  defaultUpsert: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    rateLimitBucket: {
      upsert: rateLimitMocks.defaultUpsert,
    },
  },
}));

import {
  RateLimitUnavailableError,
  checkIpRateLimit,
  checkUserRateLimit,
  enforceUserRateLimit,
  getConfiguredTrustedClientIp,
  getTrustedClientIp,
} from "@/lib/rate-limit";

const secret = "test-only-rate-limit-secret-value";

interface ObservedUpsertInput {
  where: {
    scope_subjectHash_windowStart: {
      scope: string;
      subjectHash: string;
      windowStart: Date;
    };
  };
  create: {
    subjectHash: string;
    count: number;
    expiresAt: Date;
  };
}

function storeReturning(count: number) {
  return {
    rateLimitBucket: {
      upsert: vi.fn(async (input: unknown) => {
        void input;
        return { count };
      }),
    },
  };
}

describe("durable rate limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses an atomic fixed-window bucket with a keyed subject hash", async () => {
    const store = storeReturning(1);
    const decision = await checkUserRateLimit(
      {
        scope: "transaction-create",
        userId: "private-user-id",
        limit: 10,
        windowSeconds: 60,
      },
      {
        now: new Date("2026-07-15T10:22:31.500Z"),
        secret,
        store,
      },
    );

    expect(decision).toEqual({
      allowed: true,
      limit: 10,
      remaining: 9,
      retryAfterSeconds: 0,
    });
    const upsertInput = store.rateLimitBucket.upsert.mock.calls[0]?.[0] as
      | ObservedUpsertInput
      | undefined;

    if (!upsertInput) {
      throw new Error("Expected a rate-limit upsert.");
    }

    const uniqueBucket = upsertInput.where.scope_subjectHash_windowStart;

    expect(uniqueBucket.scope).toBe("transaction-create");
    expect(uniqueBucket.windowStart).toEqual(
      new Date("2026-07-15T10:22:00.000Z"),
    );
    expect(uniqueBucket.subjectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(uniqueBucket.subjectHash).not.toContain("private-user-id");
    expect(JSON.stringify(upsertInput)).not.toContain("private-user-id");
    expect(upsertInput).toMatchObject({
      create: {
        count: 1,
        expiresAt: new Date("2026-07-15T10:23:00.000Z"),
      },
      update: {
        count: { increment: 1 },
        expiresAt: new Date("2026-07-15T10:23:00.000Z"),
      },
      select: { count: true },
    });
  });

  it("returns controlled retry timing and the enforcing API rejects", async () => {
    const store = storeReturning(11);

    const decision = await checkUserRateLimit(
      {
        scope: "transaction-create",
        userId: "user-1",
        limit: 10,
        windowSeconds: 60,
      },
      {
        now: new Date("2026-07-15T10:22:44.100Z"),
        secret,
        store,
      },
    );

    expect(decision).toEqual({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 16,
    });

    await expect(
      enforceUserRateLimit(
        {
          scope: "transaction-create",
          userId: "user-1",
          limit: 10,
          windowSeconds: 60,
        },
        {
          now: new Date("2026-07-15T10:22:44.100Z"),
          secret,
          store,
        },
      ),
    ).rejects.toMatchObject({
      retryAfterSeconds: 16,
    });
  });

  it("fails closed when durable storage is unavailable", async () => {
    const store = {
      rateLimitBucket: {
        upsert: vi.fn(async () => {
          throw new Error("database details must not escape");
        }),
      },
    };

    await expect(
      checkUserRateLimit(
        {
          scope: "transaction-history",
          userId: "user-1",
          limit: 10,
          windowSeconds: 60,
        },
        { secret, store },
      ),
    ).rejects.toEqual(new RateLimitUnavailableError());
  });

  it("separates user and IP hash namespaces", async () => {
    const userStore = storeReturning(1);
    const ipStore = storeReturning(1);

    await checkUserRateLimit(
      {
        scope: "authentication",
        userId: "203.0.113.8",
        limit: 5,
        windowSeconds: 60,
      },
      { secret, store: userStore },
    );
    await checkIpRateLimit(
      {
        scope: "authentication",
        ip: "203.0.113.8",
        limit: 5,
        windowSeconds: 60,
      },
      { secret, store: ipStore },
    );

    const userInput = userStore.rateLimitBucket.upsert.mock.calls[0]?.[0] as
      | ObservedUpsertInput
      | undefined;
    const ipInput = ipStore.rateLimitBucket.upsert.mock.calls[0]?.[0] as
      | ObservedUpsertInput
      | undefined;
    const userHash = userInput?.create.subjectHash;
    const ipHash = ipInput?.create.subjectHash;

    expect(userHash).not.toBe(ipHash);
  });
});

describe("trusted client IP parsing", () => {
  it("ignores arbitrary forwarded headers without an explicit trusted proxy", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.10, 10.0.0.5",
      "cf-connecting-ip": "203.0.113.11",
    });

    expect(getTrustedClientIp({ headers })).toBeNull();
    expect(
      getTrustedClientIp({
        headers,
        peerIp: "192.0.2.4",
      }),
    ).toBe("192.0.2.4");
  });

  it("uses only the header declared by the trusted deployment mode", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.10, 10.0.0.5",
      "cf-connecting-ip": "203.0.113.11",
    });

    expect(
      getTrustedClientIp({ headers, proxyMode: "forwarded" }),
    ).toBe("203.0.113.10");
    expect(getTrustedClientIp({ headers, proxyMode: "vercel" })).toBe(
      "203.0.113.10",
    );
    expect(getTrustedClientIp({ headers, proxyMode: "cloudflare" })).toBe(
      "203.0.113.11",
    );
  });

  it("recognizes Vercel's platform signal as its trusted proxy mode", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.12",
    });

    expect(
      getConfiguredTrustedClientIp(headers, null, { VERCEL: "1" }),
    ).toBe("203.0.113.12");
  });

  it("rejects malformed trusted headers and falls back only to a valid peer", () => {
    const headers = new Headers({
      "x-forwarded-for": "attacker-controlled-value",
    });

    expect(
      getTrustedClientIp({
        headers,
        proxyMode: "forwarded",
        peerIp: "198.51.100.7",
      }),
    ).toBe("198.51.100.7");
  });
});
