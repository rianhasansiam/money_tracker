import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitExceededError } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({
  enforceIpRateLimit: vi.fn(),
  getConfiguredTrustedClientIp: vi.fn(),
  headers: vi.fn(),
  logServerEvent: vi.fn(),
  redirect: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/auth", () => ({
  signIn: mocks.signIn,
}));

vi.mock("@/lib/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability")>();

  return {
    ...actual,
    createCorrelationId: () => "00000000-0000-4000-8000-000000000001",
    logServerEvent: mocks.logServerEvent,
  };
});

vi.mock("@/lib/rate-limit", () => {
  class MockRateLimitExceededError extends Error {
    constructor(public readonly retryAfterSeconds: number) {
      super("The rate limit was exceeded.");
      this.name = "RateLimitExceededError";
    }
  }

  class MockRateLimitUnavailableError extends Error {
    constructor() {
      super("The rate-limit service is unavailable.");
      this.name = "RateLimitUnavailableError";
    }
  }

  return {
    RateLimitExceededError: MockRateLimitExceededError,
    RateLimitUnavailableError: MockRateLimitUnavailableError,
    enforceIpRateLimit: mocks.enforceIpRateLimit,
    getConfiguredTrustedClientIp: mocks.getConfiguredTrustedClientIp,
  };
});

import { beginGoogleSignIn } from "@/actions/authentication";

describe("Google authentication entry action", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    mocks.headers.mockResolvedValue(new Headers());
    mocks.getConfiguredTrustedClientIp.mockReturnValue(null);
    mocks.enforceIpRateLimit.mockResolvedValue({ allowed: true });
    mocks.signIn.mockResolvedValue(undefined);
    mocks.redirect.mockImplementation((location: string) => {
      throw new Error(`redirect:${location}`);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses an IP quota when the configured proxy supplies a trusted address", async () => {
    mocks.getConfiguredTrustedClientIp.mockReturnValue("203.0.113.20");

    await beginGoogleSignIn("/dashboard");

    expect(mocks.enforceIpRateLimit).toHaveBeenCalledWith({
      scope: "authentication-start",
      ip: "203.0.113.20",
      limit: 20,
      windowSeconds: 300,
    });
    expect(mocks.signIn).toHaveBeenCalledWith("google", {
      redirectTo: "/dashboard",
    });
  });

  it("does not trust an unavailable client address during local execution", async () => {
    await beginGoogleSignIn("https://attacker.example/return");

    expect(mocks.enforceIpRateLimit).not.toHaveBeenCalled();
    expect(mocks.signIn).toHaveBeenCalledWith("google", {
      redirectTo: "/groups",
    });
  });

  it("returns controlled retry information when the IP quota is exceeded", async () => {
    mocks.getConfiguredTrustedClientIp.mockReturnValue("203.0.113.21");
    mocks.enforceIpRateLimit.mockRejectedValue(new RateLimitExceededError(42));

    await expect(beginGoogleSignIn()).rejects.toThrow(
      "redirect:/login?authError=rate_limited&retryAfter=42",
    );
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("fails closed in production when no trustworthy client IP is available", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(beginGoogleSignIn()).rejects.toThrow(
      /redirect:\/login\?authError=unavailable&reference=/,
    );
    expect(mocks.logServerEvent).toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
});
