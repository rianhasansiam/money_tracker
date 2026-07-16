export interface SecurityHeader {
  key: string;
  value: string;
}

interface ContentSecurityPolicyOptions {
  isDevelopment: boolean;
}

type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

const CONTENT_SECURITY_POLICY_HEADER =
  "Content-Security-Policy-Report-Only";

function compactPolicy(directives: string[]) {
  return directives.join("; ");
}

/**
 * This policy deliberately remains report-only until production violation data
 * has been reviewed. The inline allowances are the documented nonce-free Next.js
 * compatibility mode; moving to enforcement requires per-request nonces or a
 * proven hash/SRI deployment.
 */
export function buildContentSecurityPolicy({
  isDevelopment,
}: ContentSecurityPolicyOptions) {
  const scriptSources = ["'self'", "'unsafe-inline'"];
  const connectSources = ["'self'"];

  if (isDevelopment) {
    scriptSources.push("'unsafe-eval'");
    connectSources.push("ws:", "wss:");
  }

  return compactPolicy([
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://lh3.googleusercontent.com",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self' blob:",
    "media-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "manifest-src 'self'",
  ]);
}

export function isHttpsProductionDeployment(
  environment: DeploymentEnvironment,
) {
  if (environment.NODE_ENV !== "production") {
    return false;
  }

  if (environment.VERCEL === "1") {
    return true;
  }

  try {
    return new URL(environment.AUTH_URL ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

export function buildSecurityHeaders(options: {
  isDevelopment: boolean;
  includeHsts: boolean;
}): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    {
      key: CONTENT_SECURITY_POLICY_HEADER,
      value: buildContentSecurityPolicy({
        isDevelopment: options.isDevelopment,
      }),
    },
    {
      key: "X-Frame-Options",
      value: "DENY",
    },
    {
      key: "X-Content-Type-Options",
      value: "nosniff",
    },
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    },
    {
      key: "Permissions-Policy",
      value:
        "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    },
  ];

  if (options.includeHsts) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000",
    });
  }

  return headers;
}

export function buildApplicationHeaderRules(
  environment: DeploymentEnvironment,
) {
  return [
    {
      source: "/:path*",
      headers: buildSecurityHeaders({
        isDevelopment: environment.NODE_ENV === "development",
        includeHsts: isHttpsProductionDeployment(environment),
      }),
    },
  ];
}

