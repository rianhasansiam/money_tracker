"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/lib/auth";
import { reauthenticationLocation, safeAuthenticationReturn } from "@/lib/auth-return";
import {
  AuthenticationStartUnavailableError,
  enforceAuthenticationStart,
} from "@/lib/authentication-start";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
} from "@/lib/rate-limit";

export async function beginGoogleSignIn(redirectTo = "/groups") {
  const requestHeaders = await headers();
  let denialLocation: string | null = null;

  try {
    // Auth.js' server signIn calls its core directly, rather than the public
    // HTTP handler. Charging here and at that handler counts either path once.
    await enforceAuthenticationStart(requestHeaders);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
    denialLocation = `/login?authError=rate_limited&retryAfter=${error.retryAfterSeconds}`;
    } else if (error instanceof AuthenticationStartUnavailableError) {
      denialLocation = `/login?authError=unavailable&reference=${encodeURIComponent(error.reference)}`;
    } else if (error instanceof RateLimitUnavailableError) {
      denialLocation = "/login?authError=unavailable";
    } else {
      throw error;
    }
  }

  if (denialLocation) {
    redirect(`${denialLocation}&returnTo=${encodeURIComponent(safeAuthenticationReturn(redirectTo))}`);
  }

  await signIn("google", {
    redirectTo: safeAuthenticationReturn(redirectTo),
  });
}

export async function beginReauthentication(returnTo = "/groups") {
  // Only a validated navigation location survives. No action, confirmation,
  // account target or sensitive draft is persisted or automatically replayed.
  await signOut({ redirectTo: reauthenticationLocation(returnTo) });
}
