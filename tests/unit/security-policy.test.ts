import { describe, expect, it } from "vitest";
import {
  AuthDeploymentConfigurationError,
  RecentAuthenticationRequiredError,
  assertRecentAuthentication,
  isAuthRequestHostAllowed,
  isRecentAuthentication,
  resolveAuthDeploymentConfig,
} from "@/lib/security-policy";

describe("authentication deployment policy", () => {
  it("requires one canonical HTTPS origin for production self-hosting", () => {
    expect(() =>
      resolveAuthDeploymentConfig({ NODE_ENV: "production" }),
    ).toThrow(AuthDeploymentConfigurationError);
    expect(() =>
      resolveAuthDeploymentConfig({
        NODE_ENV: "production",
        AUTH_URL: "http://finance.example.test",
      }),
    ).toThrow(AuthDeploymentConfigurationError);
    expect(() =>
      resolveAuthDeploymentConfig({
        NODE_ENV: "production",
        AUTH_URL: "https://finance.example.test/unexpected-path",
      }),
    ).toThrow(AuthDeploymentConfigurationError);

    expect(
      resolveAuthDeploymentConfig({
        NODE_ENV: "production",
        AUTH_URL: "https://finance.example.test",
      }),
    ).toEqual({
      topology: "self-hosted",
      trustHost: true,
      canonicalOrigin: "https://finance.example.test",
    });
  });

  it("allows an exact HTTP loopback origin for a local production preview", () => {
    expect(
      resolveAuthDeploymentConfig({
        NODE_ENV: "production",
        AUTH_URL: "http://localhost:3000",
      }),
    ).toEqual({
      topology: "local-development",
      trustHost: true,
      canonicalOrigin: "http://localhost:3000",
    });

    expect(() =>
      resolveAuthDeploymentConfig({
        NODE_ENV: "production",
        AUTH_URL: "http://money.example.test",
      }),
    ).toThrow(AuthDeploymentConfigurationError);
  });

  it("allows dynamic hosts only on the explicitly recognized managed platform", () => {
    const deployment = resolveAuthDeploymentConfig({
      NODE_ENV: "production",
      VERCEL: "1",
    });

    expect(deployment.topology).toBe("managed");
    expect(
      isAuthRequestHostAllowed(
        new Headers({ host: "trusted-preview.example.test" }),
        deployment,
      ),
    ).toBe(true);
  });

  it("rejects forged and multi-valued forwarded hosts for self-hosting", () => {
    const deployment = resolveAuthDeploymentConfig({
      NODE_ENV: "production",
      AUTH_URL: "https://finance.example.test",
    });

    expect(
      isAuthRequestHostAllowed(
        new Headers({
          host: "internal:3000",
          "x-forwarded-host": "finance.example.test",
          "x-forwarded-proto": "https",
        }),
        deployment,
      ),
    ).toBe(true);
    expect(
      isAuthRequestHostAllowed(
        new Headers({
          host: "internal:3000",
          "x-forwarded-host": "attacker.example.test",
          "x-forwarded-proto": "https",
        }),
        deployment,
      ),
    ).toBe(false);
    expect(
      isAuthRequestHostAllowed(
        new Headers({
          host: "finance.example.test",
          "x-forwarded-host": "finance.example.test, attacker.example.test",
          "x-forwarded-proto": "https",
        }),
        deployment,
      ),
    ).toBe(false);
  });

  it("limits configuration-free development requests to loopback hosts", () => {
    const deployment = resolveAuthDeploymentConfig({ NODE_ENV: "test" });

    expect(
      isAuthRequestHostAllowed(
        new Headers({ host: "127.0.0.1:3000" }),
        deployment,
      ),
    ).toBe(true);
    expect(
      isAuthRequestHostAllowed(
        new Headers({ host: "developer-laptop.example.test:3000" }),
        deployment,
      ),
    ).toBe(false);
  });
});

describe("recent authentication policy", () => {
  const now = new Date("2026-07-15T10:00:00.000Z");

  it("accepts a recent successful sign-in and rejects stale or absent state", () => {
    expect(
      isRecentAuthentication(new Date("2026-07-15T09:50:00.000Z"), now),
    ).toBe(true);
    expect(
      isRecentAuthentication(new Date("2026-07-15T09:44:59.999Z"), now),
    ).toBe(false);
    expect(isRecentAuthentication(null, now)).toBe(false);
  });

  it("returns a stable reauthentication error", () => {
    expect(() =>
      assertRecentAuthentication(new Date("2026-07-15T09:00:00.000Z"), now),
    ).toThrow(RecentAuthenticationRequiredError);
  });
});
