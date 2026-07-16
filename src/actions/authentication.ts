"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import {
  createCorrelationId,
  logServerEvent,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
  enforceIpRateLimit,
  getConfiguredTrustedClientIp,
} from "@/lib/rate-limit";
import { resolveAuthDeploymentConfig } from "@/lib/security-policy";

const ALLOWED_AUTH_REDIRECTS = new Set(["/groups", "/dashboard"]);

function safeRedirectTarget(value: string) {
  return ALLOWED_AUTH_REDIRECTS.has(value) ? value : "/groups";
}

export async function beginGoogleSignIn(redirectTo = "/groups") {
  const requestHeaders = await headers();
  const authDeployment = resolveAuthDeploymentConfig(process.env);
  const trustedClientIp = getConfiguredTrustedClientIp(requestHeaders);
  // A production preview bound to an exact loopback AUTH_URL has no trusted
  // proxy peer to identify. Keep protection enabled with one shared local
  // bucket instead of trusting a requester-controlled forwarding header.
  const clientIp =
    trustedClientIp ??
    (process.env.NODE_ENV === "production" &&
    authDeployment.topology === "local-development"
      ? "127.0.0.1"
      : null);
  let denialLocation: string | null = null;

  if (!clientIp && process.env.NODE_ENV === "production") {
    const correlationId = createCorrelationId();
    logServerEvent(
      "warn",
      SERVER_ERROR_CATEGORY.configuration,
      "authentication_client_ip_unavailable",
      { correlationId },
    );
    denialLocation = `/login?authError=unavailable&reference=${encodeURIComponent(
      correlationId,
    )}`;
  }

  if (clientIp) {
    try {
      await enforceIpRateLimit({
        scope: "authentication-start",
        ip: clientIp,
        limit: 20,
        windowSeconds: 5 * 60,
      });
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        denialLocation = `/login?authError=rate_limited&retryAfter=${error.retryAfterSeconds}`;
      } else if (error instanceof RateLimitUnavailableError) {
        denialLocation = "/login?authError=unavailable";
      } else {
        throw error;
      }
    }
  }

  if (denialLocation) {
    redirect(denialLocation);
  }

  await signIn("google", {
    redirectTo: safeRedirectTarget(redirectTo),
  });
}
