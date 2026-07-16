const LOCAL_DEVELOPMENT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export const AUTH_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
export const AUTH_SESSION_UPDATE_AGE_SECONDS = 15 * 60;
export const RECENT_AUTHENTICATION_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

type AuthDeploymentTopology =
  | "managed"
  | "self-hosted"
  | "local-development";

export interface AuthDeploymentConfig {
  topology: AuthDeploymentTopology;
  trustHost: true;
  canonicalOrigin: string | null;
}

export interface AuthDeploymentEnvironment {
  AUTH_URL?: string;
  NODE_ENV?: string;
  VERCEL?: string;
}

export class AuthDeploymentConfigurationError extends Error {
  constructor() {
    super("The authentication deployment configuration is invalid.");
    this.name = "AuthDeploymentConfigurationError";
  }
}

export class RecentAuthenticationRequiredError extends Error {
  constructor() {
    super("Please sign in again before performing this operation.");
    this.name = "RecentAuthenticationRequiredError";
  }
}

function parseCanonicalOrigin(value: string, requireHttps: boolean) {
  try {
    const url = new URL(value);
    const isSupportedProtocol =
      url.protocol === "https:" || (!requireHttps && url.protocol === "http:");

    if (
      !isSupportedProtocol ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      throw new AuthDeploymentConfigurationError();
    }

    return url.origin;
  } catch (error) {
    if (error instanceof AuthDeploymentConfigurationError) {
      throw error;
    }

    throw new AuthDeploymentConfigurationError();
  }
}

export function resolveAuthDeploymentConfig(
  environment: AuthDeploymentEnvironment,
): AuthDeploymentConfig {
  const isProduction = environment.NODE_ENV === "production";
  const isManaged = environment.VERCEL === "1";
  const configuredUrl = environment.AUTH_URL?.trim();

  if (isManaged) {
    return {
      topology: "managed",
      trustHost: true,
      canonicalOrigin: configuredUrl
        ? parseCanonicalOrigin(configuredUrl, isProduction)
        : null,
    };
  }

  if (!isProduction) {
    return {
      topology: "local-development",
      trustHost: true,
      canonicalOrigin: configuredUrl
        ? parseCanonicalOrigin(configuredUrl, false)
        : null,
    };
  }

  if (!configuredUrl) {
    throw new AuthDeploymentConfigurationError();
  }

  return {
    topology: "self-hosted",
    trustHost: true,
    canonicalOrigin: parseCanonicalOrigin(configuredUrl, true),
  };
}

function singleHeaderValue(value: string | null) {
  if (!value || value.includes(",") || /\s/.test(value)) {
    return null;
  }

  return value.toLowerCase();
}

function requestOrigin(headers: Headers, fallbackProtocol: "http:" | "https:") {
  const host = singleHeaderValue(
    headers.get("x-forwarded-host") ?? headers.get("host"),
  );
  const forwardedProtocol = singleHeaderValue(headers.get("x-forwarded-proto"));
  const protocol = forwardedProtocol
    ? forwardedProtocol.endsWith(":")
      ? forwardedProtocol
      : `${forwardedProtocol}:`
    : fallbackProtocol;

  if (!host || (protocol !== "http:" && protocol !== "https:")) {
    return null;
  }

  try {
    return new URL(`${protocol}//${host}`).origin;
  } catch {
    return null;
  }
}

export function isAuthRequestHostAllowed(
  headers: Headers,
  deployment: AuthDeploymentConfig,
) {
  if (deployment.topology === "managed") {
    // The managed topology is intentionally dynamic and is safe only because
    // the platform is responsible for normalizing Host/forwarded headers.
    return true;
  }

  if (deployment.canonicalOrigin) {
    const expected = new URL(deployment.canonicalOrigin);
    return requestOrigin(headers, expected.protocol as "http:" | "https:") === expected.origin;
  }

  if (deployment.topology !== "local-development") {
    return false;
  }

  const host = singleHeaderValue(
    headers.get("x-forwarded-host") ?? headers.get("host"),
  );

  if (!host) {
    return false;
  }

  try {
    const parsed = new URL(`http://${host}`);
    return LOCAL_DEVELOPMENT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function isActiveUserState(user: {
  status?: string | null;
  disabledAt?: Date | null;
  deletedAt?: Date | null;
}) {
  return (
    user.status === "ACTIVE" &&
    user.disabledAt == null &&
    user.deletedAt == null
  );
}

export function isRecentAuthentication(
  lastAuthenticatedAt: Date | null | undefined,
  now = new Date(),
  maximumAgeMs = RECENT_AUTHENTICATION_MAX_AGE_MS,
) {
  if (
    !lastAuthenticatedAt ||
    Number.isNaN(lastAuthenticatedAt.getTime()) ||
    Number.isNaN(now.getTime()) ||
    !Number.isFinite(maximumAgeMs) ||
    maximumAgeMs < 0
  ) {
    return false;
  }

  const age = now.getTime() - lastAuthenticatedAt.getTime();
  return age >= -MAX_CLOCK_SKEW_MS && age <= maximumAgeMs;
}

export function assertRecentAuthentication(
  lastAuthenticatedAt: Date | null | undefined,
  now = new Date(),
) {
  if (!isRecentAuthentication(lastAuthenticatedAt, now)) {
    throw new RecentAuthenticationRequiredError();
  }
}
