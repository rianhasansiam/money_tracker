import { describe, expect, it } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import nextConfig from "../../next.config";
import {
  buildApplicationHeaderRules,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  isHttpsProductionDeployment,
} from "@/lib/security-headers";

function toHeaderMap(headers: Array<{ key: string; value: string }>) {
  return new Map(headers.map((header) => [header.key, header.value]));
}

describe("browser security headers", () => {
  it("keeps CSP report-only and includes the required containment directives", () => {
    const headers = toHeaderMap(
      buildSecurityHeaders({ isDevelopment: false, includeHsts: false }),
    );
    const csp = headers.get("Content-Security-Policy-Report-Only");

    expect(headers.has("Content-Security-Policy")).toBe(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain(
      "form-action 'self' https://accounts.google.com",
    );
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
  });

  it("allows development tooling only in the development policy", () => {
    const developmentPolicy = buildContentSecurityPolicy({
      isDevelopment: true,
    });
    const productionPolicy = buildContentSecurityPolicy({
      isDevelopment: false,
    });

    expect(developmentPolicy).toContain("'unsafe-eval'");
    expect(developmentPolicy).toContain("ws:");
    expect(productionPolicy).not.toContain("'unsafe-eval'");
    expect(productionPolicy).not.toContain("ws:");
  });

  it("emits HSTS only for a known HTTPS production deployment", () => {
    expect(
      isHttpsProductionDeployment({
        NODE_ENV: "development",
        AUTH_URL: "https://money.example.com",
      }),
    ).toBe(false);
    expect(
      isHttpsProductionDeployment({
        NODE_ENV: "production",
        AUTH_URL: "http://money.example.com",
      }),
    ).toBe(false);
    expect(
      isHttpsProductionDeployment({
        NODE_ENV: "production",
        AUTH_URL: "https://money.example.com",
      }),
    ).toBe(true);
    expect(
      isHttpsProductionDeployment({
        NODE_ENV: "production",
        VERCEL: "1",
      }),
    ).toBe(true);
  });

  it.each(["/", "/login", "/dashboard", "/dashboard/team", "/groups"])(
    "covers the public or protected HTML route %s with the global rule",
    async (route) => {
      const rules = buildApplicationHeaderRules({
        NODE_ENV: "production",
        AUTH_URL: "https://money.example.com",
      });
      const response = await unstable_getResponseFromNextConfig({
        url: `https://money.example.com${route}`,
        nextConfig: {
          poweredByHeader: false,
          async headers() {
            return rules;
          },
        },
      });

      expect(response.headers.has("Content-Security-Policy-Report-Only")).toBe(
        true,
      );
      expect(response.headers.get("Strict-Transport-Security")).toBe(
        "max-age=31536000",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    },
  );

  it("disables the framework disclosure header in Next configuration", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.headers).toBeTypeOf("function");

    const rules = await nextConfig.headers?.();
    const headerMap = toHeaderMap(rules?.[0]?.headers ?? []);

    expect(headerMap.has("Content-Security-Policy-Report-Only")).toBe(true);
  });
});
