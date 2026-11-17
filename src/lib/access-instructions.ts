import { resolveAuthDeploymentConfig } from "@/lib/security-policy";

interface CanonicalAccessEnvironment {
  AUTH_URL?: string;
  NODE_ENV?: string;
  VERCEL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_URL?: string;
  VERCEL_ENV?: string;
}

export function canonicalSignInUrl(environment: CanonicalAccessEnvironment): string | null {
  try {
    const deployment = resolveAuthDeploymentConfig(environment);
    if (deployment.canonicalOrigin) return new URL("/login", deployment.canonicalOrigin).toString();
    if (environment.VERCEL !== "1") return null;
    // A preview invitation belongs to that deployment's database. Do not send
    // its recipient to a different production deployment merely because the
    // platform also exposes the production project's domain.
    const host = environment.VERCEL_ENV === "production"
      ? environment.VERCEL_PROJECT_PRODUCTION_URL || environment.VERCEL_URL
      : environment.VERCEL_URL || environment.VERCEL_PROJECT_PRODUCTION_URL;
    if (!host || /[\s/@?#\\]/.test(host)) return null;
    const origin = new URL(`https://${host}`);
    if (!origin.hostname || origin.pathname !== "/" || origin.username || origin.password) return null;
    return new URL("/login", origin).toString();
  } catch {
    return null;
  }
}

export function invitationAccessInstructions(input: { email: string; expiresAt: string; signInUrl: string }) {
  const expiry = new Intl.DateTimeFormat("en-BD", {
    dateStyle: "medium", timeStyle: "long", timeZone: "Asia/Dhaka",
  }).format(new Date(input.expiresAt));
  return [
    "Money Tracker access instructions",
    `Sign in: ${input.signInUrl}`,
    `Use this Google account: ${input.email}`,
    `Invitation expires: ${expiry} (Asia/Dhaka).`,
    "After signing in, open Teams, discover the correct team, and request to join.",
    "A team Admin or Moderator must approve your request before you can view its ledger.",
    "No email has been sent by Money Tracker.",
  ].join("\n");
}
