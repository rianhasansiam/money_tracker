import {
  createCorrelationId,
  logServerEvent,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";
import {
  RateLimitUnavailableError,
  enforceIpRateLimit,
  getConfiguredTrustedClientIp,
} from "@/lib/rate-limit";
import { resolveAuthDeploymentConfig } from "@/lib/security-policy";

export class AuthenticationStartUnavailableError extends RateLimitUnavailableError {
  constructor(public readonly reference: string) {
    super();
    this.name = "AuthenticationStartUnavailableError";
  }
}

/** Shared by the UI action and the independently reachable Auth.js HTTP route. */
export async function enforceAuthenticationStart(requestHeaders: Headers) {
  const deployment = resolveAuthDeploymentConfig(process.env);
  const clientIp =
    getConfiguredTrustedClientIp(requestHeaders) ??
    (process.env.NODE_ENV === "production" && deployment.topology === "local-development"
      ? "127.0.0.1"
      : null);

  if (!clientIp && process.env.NODE_ENV === "production") {
    const reference = createCorrelationId();
    logServerEvent(
      "warn",
      SERVER_ERROR_CATEGORY.configuration,
      "authentication_client_ip_unavailable",
      { correlationId: reference },
    );
    throw new AuthenticationStartUnavailableError(reference);
  }

  if (clientIp) {
    await enforceIpRateLimit({
      scope: "authentication-start",
      ip: clientIp,
      limit: 20,
      windowSeconds: 5 * 60,
    });
  }
}
