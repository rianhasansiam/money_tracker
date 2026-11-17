import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitExceededError, RateLimitUnavailableError } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({
  enforceIpRateLimit: vi.fn(),
  getConfiguredTrustedClientIp: vi.fn(),
  headers: vi.fn(),
  logServerEvent: vi.fn(),
  redirect: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/auth", () => ({
  signIn: mocks.signIn,
  signOut: mocks.signOut,
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

import { beginGoogleSignIn, beginReauthentication } from "@/actions/authentication";

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
    expect(mocks.enforceIpRateLimit).toHaveBeenCalledTimes(1);
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
    vi.stubEnv("AUTH_URL", "https://finance.example.test");

    await expect(beginGoogleSignIn()).rejects.toThrow(
      /redirect:\/login\?authError=unavailable&reference=/,
    );
    expect(mocks.logServerEvent).toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("uses a shared limiter bucket for a loopback production preview", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "http://localhost:3000");

    await beginGoogleSignIn();

    expect(mocks.enforceIpRateLimit).toHaveBeenCalledWith({
      scope: "authentication-start",
      ip: "127.0.0.1",
      limit: 20,
      windowSeconds: 300,
    });
    expect(mocks.signIn).toHaveBeenCalledWith("google", {
      redirectTo: "/groups",
    });
  });

  it("fails closed when the shared durable limiter is unavailable", async () => {
    mocks.getConfiguredTrustedClientIp.mockReturnValue("203.0.113.22");
    mocks.enforceIpRateLimit.mockRejectedValue(new RateLimitUnavailableError());
    await expect(beginGoogleSignIn()).rejects.toThrow("redirect:/login?authError=unavailable");
    expect(mocks.enforceIpRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("reauthenticates through sign-out and a validated internal return without replaying a mutation", async () => {
    await beginReauthentication("/admin?view=recovery&recoveryQ=Treasury&operation=purge");
    const target = mocks.signOut.mock.calls.at(-1)?.[0].redirectTo as string;
    const url = new URL(target, "https://local.invalid");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("reauth")).toBe("1");
    expect(url.searchParams.get("returnTo")).toBe("/admin?view=recovery&recoveryQ=Treasury");
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.enforceIpRateLimit).not.toHaveBeenCalled();
  });
});
